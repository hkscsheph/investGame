const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let gameState = {
    round: 1,
    maxRounds: 5,        // 總回合數
    compoundingFreq: 12, // 預設複利次數 (12 = 月複利)
    isRoundActive: true
};

let players = {};
let gmSocketId = null;

// 複利計算輔助函式
function calculateCompound(principal, ratePercent, freq) {
    if (principal === 0) return 0;
    const r = ratePercent / 100;
    // 公式: A = P * (1 + r/n)^n
    // 如果頻率為 1，則等同於單利
    return principal * Math.pow((1 + r / freq), freq);
}

io.on('connection', (socket) => {
    // --- 登入 ---
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
                history: [10000],
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

    // --- 玩家操作 ---
    socket.on('submitAllocation', (alloc) => {
        if (!players[socket.id]) return;
        if (alloc.a + alloc.b + alloc.c !== 100) {
             socket.emit('msg', '總配置必須為 100%');
             return;
        }
        players[socket.id].currentAlloc = alloc;
        players[socket.id].submitted = true;
        socket.emit('submissionConfirmed');
        updateGMView();
    });

    // --- GM 操作: 結算回合 (核心數學邏輯修改處) ---
    socket.on('gmProcessRound', (rates) => {
        if (socket.id !== gmSocketId) return;

        const freq = gameState.compoundingFreq || 12;

        for (let pId in players) {
            let p = players[pId];
            if (!p.submitted) p.currentAlloc = { a:0, b:0, c:0 }; 
            
            // 1. 分配本金
            let principalA = p.balance * (p.currentAlloc.a / 100);
            let principalB = p.balance * (p.currentAlloc.b / 100);
            let principalC = p.balance * (p.currentAlloc.c / 100);

            // 2. 計算複利後的新本金 (New Principal)
            let newA = calculateCompound(principalA, rates.a, freq);
            let newB = calculateCompound(principalB, rates.b, freq);
            let newC = calculateCompound(principalC, rates.c, freq);

            // 3. 計算總收益 (Total Gain)
            let newBalance = newA + newB + newC;
            let gain = newBalance - p.balance;

            // 4. 更新玩家數據
            p.balance = newBalance;
            p.history.push(p.balance);
            p.submitted = false;

            io.to(p.id).emit('roundResult', {
                round: gameState.round,
                gain: gain,
                newBalance: p.balance,
                rates: rates,
                freq: freq // 讓前端知道是用多少次複利算的
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

    // --- GM 操作: 重置遊戲與設定 ---
    socket.on('gmRestartGame', (settings) => {
        if (socket.id !== gmSocketId) return;
        
        // 更新遊戲設定
        gameState.round = 1;
        gameState.maxRounds = parseInt(settings.maxRounds) || 5;
        gameState.compoundingFreq = parseInt(settings.freq) || 12; // 讀取複利設定

        // 重置玩家
        for (let pId in players) {
            players[pId].balance = 10000;
            players[pId].history = [10000];
            players[pId].submitted = false;
            players[pId].currentAlloc = { a:0, b:0, c:0 };
            
            io.to(pId).emit('gameRestarted', { 
                balance: 10000,
                maxRounds: gameState.maxRounds,
                compoundingFreq: gameState.compoundingFreq
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
        io.to(gmSocketId).emit('gmUpdate', { players: players, state: gameState });
    }
}

const PORT = 3