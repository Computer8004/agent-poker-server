// Add this to server.js - server-side faucet endpoint

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
    
    // Server calls claimTokens on behalf of user (but tokens go to user)
    // Actually, claimTokens mints to msg.sender, so server would get tokens
    // Instead, server should call mint directly to user
    
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

/**
 * Check faucet status for user
 * GET /api/faucet/status?address=0x...
 */
app.get('/api/faucet/status', async (req, res) => {
  try {
    const { address } = req.query;
    
    if (!address || !address.startsWith('0x')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid address' 
      });
    }
    
    const canClaim = await pokerToken.canClaim(address);
    const balance = await pokerToken.balanceOf(address);
    const timeUntil = await pokerToken.timeUntilNextClaim(address);
    
    res.json({
      success: true,
      canClaim,
      balance: ethers.formatEther(balance),
      timeUntilNextClaim: Number(timeUntil)
    });
  } catch (error) {
    console.error('Faucet status error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});
