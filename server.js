require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// Contract ABIs (will be loaded from JSON)
const POKER_TOKEN_ABI = require('./abis/PokerToken.json');
const POKER_GAME_ABI = require('./abis/PokerGame.json');

// Provider and Wallet
const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
const serverWallet = new ethers.Wallet(process.env.SERVER_PRIVATE_KEY, provider);

// Contract instances
const pokerToken = new ethers.Contract(
  process.env.TOKEN_ADDRESS,
  POKER_TOKEN_ABI,
  serverWallet
);

const pokerGame = new ethers.Contract(
  process.env.GAME_ADDRESS,
  POKER_GAME_ABI,
  serverWallet
);

// In-memory game state (will use Redis in production)
const gameStates = new Map();
const playerSessions = new Map();

/**
 * Game State Management (Off-chain)
 * The server manages the actual poker game logic:
 * - Card dealing (encrypted)
 * - Turn management
 * - Action validation
 * - Hand evaluation
 * 
 * Only betting and settlement happen on-chain
 */

// Standard 52-card deck
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

class PokerEngine {
  constructor() {
    this.deck = [];
    this.resetDeck();
  }

  resetDeck() {
    this.deck = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.deck.push({ suit, rank });
      }
    }
    this.shuffle();
  }

  shuffle() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  deal(n) {
    return this.deck.splice(0, n);
  }
}

// Game phases
const PHASES = {
  WAITING: 'waiting',
  PREFLOP: 'pre-flop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  FINISHED: 'finished'
};

/**
 * Create a new game
 * POST /api/games
 */
app.post('/api/games', async (req, res) => {
  try {
    const { playerAddress, playerName, smallBlind, bigBlind, minBuyIn, maxBuyIn, maxPlayers } = req.body;
    
    // Call on-chain createGame
    const tx = await pokerGame.createGame(
      ethers.parseEther(smallBlind.toString()),
      ethers.parseEther(bigBlind.toString()),
      ethers.parseEther(minBuyIn.toString()),
      ethers.parseEther(maxBuyIn.toString()),
      maxPlayers
    );
    
    const receipt = await tx.wait();
    
    // Extract gameId from event
    const event = receipt.logs.find(
      log => log.topics[0] === pokerGame.interface.getEvent('GameCreated').topicHash
    );
    const gameId = event ? Number(event.topics[1]) : null;
    
    // Initialize off-chain game state
    gameStates.set(gameId, {
      id: gameId,
      creator: playerAddress,
      players: [{ address: playerAddress, name: playerName, chips: 0 }],
      phase: PHASES.WAITING,
      deck: new PokerEngine(),
      communityCards: [],
      pot: 0,
      currentBet: 0,
      currentTurn: null,
      dealerIndex: 0,
      smallBlind,
      bigBlind,
      actionHistory: [],
      handsDealt: false
    });
    
    res.json({
      success: true,
      gameId,
      message: 'Game created successfully'
    });
  } catch (error) {
    console.error('Create game error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Join an existing game
 * POST /api/games/:id/join
 */
app.post('/api/games/:id/join', async (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const { playerAddress, playerName } = req.body;
    
    const gameState = gameStates.get(gameId);
    if (!gameState) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }
    
    if (gameState.phase !== PHASES.WAITING) {
      return res.status(400).json({ success: false, error: 'Game already started' });
    }
    
    if (gameState.players.length >= gameState.maxPlayers) {
      return res.status(400).json({ success: false, error: 'Game full' });
    }
    
    // Add player to off-chain state
    gameState.players.push({
      address: playerAddress,
      name: playerName,
      chips: 0,
      holeCards: null,
      hasFolded: false,
      currentBet: 0
    });
    
    res.json({
      success: true,
      gameId,
      playerCount: gameState.players.length,
      maxPlayers: gameState.maxPlayers
    });
  } catch (error) {
    console.error('Join game error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Start the game (deal cards)
 * POST /api/games/:id/start
 */
app.post('/api/games/:id/start', async (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const gameState = gameStates.get(gameId);
    
    if (!gameState) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }
    
    if (gameState.players.length < 2) {
      return res.status(400).json({ success: false, error: 'Need at least 2 players' });
    }
    
    // Reset and shuffle deck
    gameState.deck.resetDeck();
    
    // Deal hole cards to each player
    for (const player of gameState.players) {
      player.holeCards = gameState.deck.deal(2);
      player.hasFolded = false;
      player.currentBet = 0;
    }
    
    // Set blinds
    const sbIndex = (gameState.dealerIndex + 1) % gameState.players.length;
    const bbIndex = (gameState.dealerIndex + 2) % gameState.players.length;
    
    gameState.players[sbIndex].currentBet = gameState.smallBlind;
    gameState.players[bbIndex].currentBet = gameState.bigBlind;
    gameState.currentBet = gameState.bigBlind;
    
    // First to act is after BB
    const firstToActIndex = (bbIndex + 1) % gameState.players.length;
    gameState.currentTurn = gameState.players[firstToActIndex].address;
    gameState.phase = PHASES.PREFLOP;
    gameState.handsDealt = true;
    
    // Call on-chain startGame
    const gameHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
      players: gameState.players.map(p => p.address),
      timestamp: Date.now()
    })));
    
    const tx = await pokerGame.startGame(gameId, gameHash);
    await tx.wait();
    
    // Notify all players
    broadcastToGame(gameId, {
      type: 'gameStarted',
      gameId,
      phase: gameState.phase,
      currentTurn: gameState.currentTurn,
      dealer: gameState.players[gameState.dealerIndex].address
    });
    
    res.json({
      success: true,
      gameId,
      phase: gameState.phase,
      currentTurn: gameState.currentTurn
    });
  } catch (error) {
    console.error('Start game error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get game state (for a specific player)
 * GET /api/games/:id/state?playerAddress=...
 */
app.get('/api/games/:id/state', async (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const playerAddress = req.query.playerAddress;
    
    const gameState = gameStates.get(gameId);
    if (!gameState) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }
    
    // Find player
    const player = gameState.players.find(p => p.address.toLowerCase() === playerAddress.toLowerCase());
    if (!player) {
      return res.status(403).json({ success: false, error: 'Not a player in this game' });
    }
    
    // Build visible state
    const visibleState = {
      gameId: gameState.id,
      phase: gameState.phase,
      communityCards: gameState.communityCards,
      pot: gameState.pot,
      currentBet: gameState.currentBet,
      currentTurn: gameState.currentTurn,
      yourCards: player.holeCards,
      yourChips: player.chips,
      yourBet: player.currentBet,
      yourPosition: gameState.players.indexOf(player),
      players: gameState.players.map(p => ({
        address: p.address,
        name: p.name,
        chips: p.chips,
        currentBet: p.currentBet,
        hasFolded: p.hasFolded,
        isDealer: gameState.players[gameState.dealerIndex].address === p.address
      })),
      actionHistory: gameState.actionHistory.slice(-20), // Last 20 actions
      availableActions: getAvailableActions(gameState, player)
    };
    
    res.json({ success: true, state: visibleState });
  } catch (error) {
    console.error('Get state error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Submit player action
 * POST /api/games/:id/action
 */
app.post('/api/games/:id/action', async (req, res) => {
  try {
    const gameId = parseInt(req.params.id);
    const { playerAddress, action, amount } = req.body;
    
    const gameState = gameStates.get(gameId);
    if (!gameState) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }
    
    // Verify it's player's turn
    if (gameState.currentTurn.toLowerCase() !== playerAddress.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Not your turn' });
    }
    
    const player = gameState.players.find(p => p.address.toLowerCase() === playerAddress.toLowerCase());
    if (!player || player.hasFolded) {
      return res.status(400).json({ success: false, error: 'Cannot act' });
    }
    
    // Process action
    await processAction(gameState, player, action, amount);
    
    // Check if betting round complete
    if (isBettingRoundComplete(gameState)) {
      await advancePhase(gameState);
    } else {
      // Move to next player
      advanceTurn(gameState);
    }
    
    // Update on-chain state
    const gameHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
      gameId,
      action,
      player: playerAddress,
      timestamp: Date.now()
    })));
    
    const tx = await pokerGame.submitAction(
      gameId,
      playerAddress,
      action,
      amount ? ethers.parseEther(amount.toString()) : 0,
      gameHash
    );
    await tx.wait();
    
    // Broadcast update
    broadcastToGame(gameId, {
      type: 'action',
      player: playerAddress,
      action,
      amount,
      currentTurn: gameState.currentTurn,
      phase: gameState.phase,
      pot: gameState.pot
    });
    
    res.json({
      success: true,
      action,
      newPhase: gameState.phase,
      currentTurn: gameState.currentTurn
    });
  } catch (error) {
    console.error('Action error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper functions
function getAvailableActions(gameState, player) {
  if (gameState.phase === PHASES.FINISHED) return [];
  if (player.hasFolded) return [];
  if (gameState.currentTurn !== player.address) return [];
  
  const actions = ['fold'];
  const toCall = gameState.currentBet - player.currentBet;
  
  if (toCall === 0) {
    actions.push('check');
  } else {
    actions.push('call');
  }
  
  if (player.chips > toCall) {
    actions.push('raise');
  }
  
  if (player.chips > 0) {
    actions.push('all-in');
  }
  
  return actions;
}

async function processAction(gameState, player, action, amount) {
  const toCall = gameState.currentBet - player.currentBet;
  
  switch (action) {
    case 'fold':
      player.hasFolded = true;
      break;
      
    case 'check':
      if (toCall !== 0) throw new Error('Cannot check');
      break;
      
    case 'call':
      if (toCall === 0) throw new Error('Cannot call');
      const callAmount = Math.min(toCall, player.chips);
      player.chips -= callAmount;
      player.currentBet += callAmount;
      gameState.pot += callAmount;
      break;
      
    case 'bet':
    case 'raise':
      const raiseAmount = amount || gameState.currentBet * 2;
      if (raiseAmount < gameState.currentBet * 2) throw new Error('Raise too small');
      const totalBet = raiseAmount;
      const additional = totalBet - player.currentBet;
      if (additional > player.chips) throw new Error('Insufficient chips');
      player.chips -= additional;
      player.currentBet = totalBet;
      gameState.currentBet = totalBet;
      gameState.pot += additional;
      break;
      
    case 'all-in':
      const allInAmount = player.chips;
      player.currentBet += allInAmount;
      gameState.pot += allInAmount;
      if (player.currentBet > gameState.currentBet) {
        gameState.currentBet = player.currentBet;
      }
      player.chips = 0;
      break;
  }
  
  gameState.actionHistory.push({
    player: player.address,
    action,
    amount,
    timestamp: Date.now()
  });
}

function isBettingRoundComplete(gameState) {
  const activePlayers = gameState.players.filter(p => !p.hasFolded);
  if (activePlayers.length <= 1) return true;
  
  // Check if all active players have matched the current bet
  return activePlayers.every(p => p.currentBet === gameState.currentBet);
}

function advanceTurn(gameState) {
  const activePlayers = gameState.players.filter(p => !p.hasFolded);
  if (activePlayers.length <= 1) return;
  
  const currentIndex = gameState.players.findIndex(p => p.address === gameState.currentTurn);
  let nextIndex = (currentIndex + 1) % gameState.players.length;
  
  while (gameState.players[nextIndex].hasFolded) {
    nextIndex = (nextIndex + 1) % gameState.players.length;
  }
  
  gameState.currentTurn = gameState.players[nextIndex].address;
}

async function advancePhase(gameState) {
  // Reset bets for new round
  gameState.players.forEach(p => p.currentBet = 0);
  gameState.currentBet = 0;
  
  switch (gameState.phase) {
    case PHASES.PREFLOP:
      gameState.communityCards = gameState.deck.deal(3); // Flop
      gameState.phase = PHASES.FLOP;
      break;
      
    case PHASES.FLOP:
      gameState.communityCards.push(...gameState.deck.deal(1)); // Turn
      gameState.phase = PHASES.TURN;
      break;
      
    case PHASES.TURN:
      gameState.communityCards.push(...gameState.deck.deal(1)); // River
      gameState.phase = PHASES.RIVER;
      break;
      
    case PHASES.RIVER:
      gameState.phase = PHASES.SHOWDOWN;
      await showdown(gameState);
      return;
  }
  
  // First to act after flop is first active player after dealer
  const dealerIndex = gameState.dealerIndex;
  let firstToAct = (dealerIndex + 1) % gameState.players.length;
  while (gameState.players[firstToAct].hasFolded) {
    firstToAct = (firstToAct + 1) % gameState.players.length;
  }
  gameState.currentTurn = gameState.players[firstToAct].address;
}

async function showdown(gameState) {
  // Evaluate hands and determine winner
  const activePlayers = gameState.players.filter(p => !p.hasFolded);
  
  // Simple winner selection (first player for now)
  // In real implementation, evaluate poker hands
  const winner = activePlayers[0];
  
  gameState.winner = winner.address;
  gameState.phase = PHASES.FINISHED;
  
  // Call on-chain finishGame
  const gameHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    winner: winner.address,
    pot: gameState.pot,
    timestamp: Date.now()
  })));
  
  const tx = await pokerGame.finishGame(gameState.id, winner.address, gameHash);
  await tx.wait();
  
  // Award pot to winner
  winner.chips += gameState.pot;
  gameState.pot = 0;
  
  broadcastToGame(gameState.id, {
    type: 'showdown',
    winner: winner.address,
    winningHand: 'Royal Flush', // Placeholder
    potWon: gameState.pot
  });
}

function broadcastToGame(gameId, message) {
  // WebSocket broadcast would go here
  console.log(`Broadcast to game ${gameId}:`, message);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🦞 Agent Poker Server running on port ${PORT}`);
  console.log(`Token: ${process.env.TOKEN_ADDRESS}`);
  console.log(`Game: ${process.env.GAME_ADDRESS}`);
});

/**
 * Server-side faucet - mints tokens to user (server pays gas)
 * POST /api/faucet/claim
 */
app.post('/api/faucet/claim', async (req, res) => {
  try {
    const { playerAddress } = req.body;
    
    if (!playerAddress || !playerAddress.startsWith('0x')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid player address' 
      });
    }
    
    // Check if user can claim
    const canClaim = await pokerToken.canClaim(playerAddress);
    if (!canClaim) {
      const nextClaim = await pokerToken.nextClaimTime(playerAddress);
      const timeUntil = Number(nextClaim) - Math.floor(Date.now() / 1000);
      const hours = Math.floor(timeUntil / 3600);
      const minutes = Math.floor((timeUntil % 3600) / 60);
      
      return res.status(429).json({
        success: false,
        error: `Please wait ${hours}h ${minutes}m before next claim`,
        nextClaimTime: Number(nextClaim)
      });
    }
    
    // Server mints tokens directly to user (server pays gas)
    const CLAIM_AMOUNT = ethers.parseEther('10000'); // 10,000 FELT
    
    const tx = await pokerToken.mint(playerAddress, CLAIM_AMOUNT);
    const receipt = await tx.wait();
    
    res.json({
      success: true,
      message: '10,000 $FELT minted to your wallet!',
      txHash: receipt.hash,
      amount: '10000'
    });
  } catch (error) {
    console.error('Faucet error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Faucet failed' 
    });
  }
});
