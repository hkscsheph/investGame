const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
    round: 1,
    maxRounds: 5, // 預設 5 回合，可由 GM 修改
    isRoundActive: true
};

let players = {};
let gmSocketId = null;

io.on('connection', (socket) => {
    // --- 登入處理 ---
    socket.on('login', (data) => {
        if (data.type === 'gm' && data.password === 'admin123') {
            gmSocketId = socket.id;
            socket.emit('loginSuccess', { type: 'gm', state: gameState });
            updateGMView();
        } else if (data.type === 'player') {
            players[socket.id] = {
                id: socket.id,
                name: data.name || '匿名玩家',
                balance: 10000,
                history: [10000], // 伺服器端紀錄歷史，用於繪製 GM 圖表
                currentAlloc: { a:0, b:0, c:0 },
                submitted: false
            };
            socket.emit('loginSuccess', { 
                type: 'player', 
                playerData: players[socket.id],
                state: gameState 
            });
            updateGMView();
        } else {
            socket.emit('loginError', '密碼錯誤');
        }
    });

    // --- 玩家提交 ---
    socket.on('submitAllocation', (alloc) => {
        if (!players[socket.id]) return;
        if (alloc.a + alloc.b + alloc.c !== 100) {
             socket.emit('msg', '總和必須為 100%');
             return;
        }
        players[socket.id].currentAlloc = alloc;
        players[socket.id].submitted = true;
        socket.emit('submissionConfirmed');
        updateGMView();
    });

    // --- GM 結算回合 ---
    socket.on('gmProcessRound', (rates) => {
        if (socket.id !== gmSocketId) return;

        const rA = rates.a / 100;
        const rB = rates.b / 100;
        const rC = rates.c / 100;

        for (let pId in players) {
            let p = players[pId];
            if (!p.submitted) p.currentAlloc = { a:0, b:0, c:0 }; // 未提交視為持有現金
            
            let investA = p.balance * (p.currentAlloc.a / 100);
            let investB = p.balance * (p.currentAlloc.b / 100);
            let investC = p.balance * (p.currentAlloc.c / 100);

            let gain = (investA * rA) + (investB * rB) + (investC * rC);
            p.balance += gain;
            p.history.push(p.balance); // 更新歷史紀錄
            p.submitted = false;

            io.to(p.id).emit('roundResult', {
                round: gameState.round,
                gain: gain,
                newBalance: p.balance,
                rates: rates
            });
        }

        gameState.round++;
        
        if(gameState.round > gameState.maxRounds) {
            io.emit('gameOver');
        } else {
            io.emit('newRoundStarted', gameState.round);
        }
        updateGMView();
    });

    // --- GM 重置遊戲 ---
    socket.on('gmRestartGame', (settings) => {
        if (socket.id !== gmSocketId) return;
        
        // 1. 更新設定
        gameState.round = 1;
        gameState.maxRounds = parseInt(settings.maxRounds) || 5;

        // 2. 重置所有玩家數據
        for (let pId in players) {
            players[pId].balance = 10000;
            players[pId].history = [10000]; // 清空伺服器紀錄
            players[pId].submitted = false;
            players[pId].currentAlloc = { a:0, b:0, c:0 };
            
            // 通知玩家前端清空圖表
            io.to(pId).emit('gameRestarted', { 
                balance: 10000,
                maxRounds: gameState.maxRounds 
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
        // 將完整包含 history 的玩家資料傳給 GM
        io.to(gmSocketId).emit('gmUpdate', { players: players, state: gameState });
    }
}

const PORT = 3000;
http.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});