const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
  round: 1,
  maxRounds: 5, // Default, can be changed by GM
  isRoundActive: true,
};

let players = {};
let gmSocketId = null;

io.on('connection', (socket) => {
  // --- LOGIN ---
  socket.on('login', (data) => {
    if (data.type === 'gm' && data.password === 'admin123') {
      gmSocketId = socket.id;
      socket.emit('loginSuccess', { type: 'gm', state: gameState });
      updateGMView();
    } else if (data.type === 'player') {
      players[socket.id] = {
        id: socket.id,
        name: data.name || 'Anonymous',
        balance: 10000,
        history: [10000], // Keep track of history on server for GM chart
        currentAlloc: { a: 0, b: 0, c: 0 },
        submitted: false,
      };
      socket.emit('loginSuccess', {
        type: 'player',
        playerData: players[socket.id],
        state: gameState,
      });
      updateGMView();
    } else {
      socket.emit('loginError', 'Invalid credentials');
    }
  });

  // --- PLAYER ACTIONS ---
  socket.on('submitAllocation', (alloc) => {
    if (!players[socket.id]) return;
    if (alloc.a + alloc.b + alloc.c !== 100) {
      socket.emit('msg', 'Total must equal 100%');
      return;
    }
    players[socket.id].currentAlloc = alloc;
    players[socket.id].submitted = true;
    socket.emit('submissionConfirmed');
    updateGMView();
  });

  // --- GM ACTIONS ---
  socket.on('gmProcessRound', (rates) => {
    if (socket.id !== gmSocketId) return;

    const rA = rates.a / 100;
    const rB = rates.b / 100;
    const rC = rates.c / 100;

    for (let pId in players) {
      let p = players[pId];
      if (!p.submitted) p.currentAlloc = { a: 0, b: 0, c: 0 };

      let investA = p.balance * (p.currentAlloc.a / 100);
      let investB = p.balance * (p.currentAlloc.b / 100);
      let investC = p.balance * (p.currentAlloc.c / 100);

      let gain = investA * rA + investB * rB + investC * rC;
      p.balance += gain;
      p.history.push(p.balance); // Add to history
      p.submitted = false;

      io.to(p.id).emit('roundResult', {
        round: gameState.round,
        gain: gain,
        newBalance: p.balance,
        rates: rates,
      });
    }

    gameState.round++;

    // Check if game is over based on dynamic maxRounds
    if (gameState.round > gameState.maxRounds) {
      io.emit('gameOver');
    } else {
      io.emit('newRoundStarted', gameState.round);
    }
    updateGMView();
  });

  // RESTART / CONFIG
  socket.on('gmRestartGame', (settings) => {
    if (socket.id !== gmSocketId) return;

    // 1. Update Settings
    gameState.round = 1;
    gameState.maxRounds = parseInt(settings.maxRounds) || 5;

    // 2. Reset Players
    for (let pId in players) {
      players[pId].balance = 10000;
      players[pId].history = [10000]; // Reset Server History
      players[pId].submitted = false;
      players[pId].currentAlloc = { a: 0, b: 0, c: 0 };

      // Tell player to wipe their local chart/logs
      io.to(pId).emit('gameRestarted', {
        balance: 10000,
        maxRounds: gameState.maxRounds,
      });
    }

    io.emit('newRoundStarted', 1);
    updateGMView();
  });

  socket.on('disconnect', () => {
    if (socket.id === gmSocketId) gmSocketId = null;
    delete players[socket.id];
    updateGMView();
  });
});

function updateGMView() {
  if (gmSocketId) {
    // Send full player object (including history) to GM for the chart
    io.to(gmSocketId).emit('gmUpdate', { players: players, state: gameState });
  }
}

const PORT = 3000;
http.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
