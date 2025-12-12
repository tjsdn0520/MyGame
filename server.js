const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

let waitingQueue = [];
const rooms = {};

// 덱 생성 (53장)
function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = ['🤡JOKER'];
    for (let s of suits) for (let r of ranks) deck.push(s + r);
    return deck;
}

function getRank(card) {
    if (card.includes('JOKER')) return 'JOKER';
    return card.substring(1); 
}

io.on('connection', (socket) => {
    console.log(`[접속] ${socket.id}`);

    socket.on('join_game', (nickname) => {
        socket.nickname = nickname || '익명';
        waitingQueue.push(socket);
        waitingQueue.forEach(s => s.emit('waiting_status', waitingQueue.length));

        if (waitingQueue.length >= 4) startGame();
    });

    socket.on('draw_card', (data) => {
        processDrawCard(data.roomID, socket.id, data.targetIndex, data.cardIndex);
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(s => s !== socket);
    });
});

function startGame() {
    const players = waitingQueue.splice(0, 4);
    const roomID = 'room_' + Date.now();
    
    rooms[roomID] = { players: players, hands: {}, turnIndex: 0, timer: null, roomID: roomID };

    let deck = createDeck();
    deck.sort(() => Math.random() - 0.5);

    players.forEach(p => { p.join(roomID); rooms[roomID].hands[p.id] = []; });

    let dealIdx = 0;
    while(deck.length > 0) {
        rooms[roomID].hands[players[dealIdx].id].push(deck.pop());
        dealIdx = (dealIdx + 1) % 4;
    }

    players.forEach(p => removePairs(rooms[roomID].hands[p.id]));

    players.forEach((p, idx) => {
        io.to(p.id).emit('game_start', {
            roomID: roomID, myIndex: idx, players: players.map(pl => pl.nickname), hand: rooms[roomID].hands[p.id]
        });
    });

    let firstTurn = 0;
    while(rooms[roomID].hands[players[firstTurn].id].length === 0) firstTurn = (firstTurn + 1) % 4;
    rooms[roomID].turnIndex = firstTurn;

    updateGameState(roomID);
    startTurnTimer(roomID);
}

function processDrawCard(roomID, playerID, targetIdx, cardIdx) {
    const room = rooms[roomID];
    if (!room) return;
    clearTimeout(room.timer);

    const currentP = room.players[room.turnIndex];
    if (playerID !== currentP.id || room.hands[currentP.id].length === 0) return;

    let validTargetIdx = targetIdx;
    if (validTargetIdx === undefined || validTargetIdx === null || room.hands[room.players[validTargetIdx].id].length === 0) {
        validTargetIdx = (room.turnIndex + 1) % 4;
        while (room.hands[room.players[validTargetIdx].id].length === 0 && validTargetIdx !== room.turnIndex) {
            validTargetIdx = (validTargetIdx + 1) % 4;
        }
    }

    const targetP = room.players[validTargetIdx];
    const targetHand = room.hands[targetP.id];
    if (targetHand.length === 0) return;

    if (cardIdx === undefined || cardIdx === null || cardIdx >= targetHand.length) {
        cardIdx = Math.floor(Math.random() * targetHand.length);
    }

    const drawnCard = targetHand.splice(cardIdx, 1)[0];
    const rank = getRank(drawnCard);
    const isPair = room.hands[currentP.id].some(c => getRank(c) === rank);
    
    room.hands[currentP.id].push(drawnCard);

    io.to(currentP.id).emit('card_drawn_animate', { card: drawnCard, isPair: isPair });
    removePairs(room.hands[currentP.id]);

    io.to(room.roomID).emit('action_log', { msg: `${currentP.nickname}님이 ${targetP.nickname}님의 카드를 뽑았습니다.` });

    const survivors = room.players.filter(p => room.hands[p.id].length > 0);
    if (survivors.length <= 1) {
        const loser = survivors.length === 1 ? survivors[0].nickname : "오류";
        updateGameState(roomID);
        setTimeout(() => {
             io.to(room.roomID).emit('game_over', { loser: loser });
             delete rooms[roomID];
        }, 2500);
        return;
    }

    let nextTurnIndex = (room.turnIndex + 1) % 4;
    while (room.hands[room.players[nextTurnIndex].id].length === 0) {
        nextTurnIndex = (nextTurnIndex + 1) % 4;
        if (nextTurnIndex === room.turnIndex) break; 
    }
    room.turnIndex = nextTurnIndex;

    updateGameState(roomID);
    startTurnTimer(roomID);
}

function startTurnTimer(roomID) {
    const room = rooms[roomID];
    if (!room) return;
    io.to(roomID).emit('timer_reset', { duration: 15 });
    room.timer = setTimeout(() => {
        const currentPlayer = room.players[room.turnIndex];
        processDrawCard(roomID, currentPlayer.id, null, null); 
    }, 15000);
}

function removePairs(hand) {
    const counts = {};
    hand.forEach(c => { const r = getRank(c); counts[r] = (counts[r] || 0) + 1; });
    const newHand = [];
    for (const card of hand) {
        const r = getRank(card);
        if (counts[r] % 2 !== 0) { newHand.push(card); counts[r]--; } 
        else if (counts[r] > 0) { counts[r]--; }
    }
    hand.length = 0;
    hand.push(...newHand);
}

function updateGameState(roomID) {
    const room = rooms[roomID];
    if(!room) return;
    const gameState = { turnIndex: room.turnIndex, playerCounts: room.players.map(p => room.hands[p.id].length) };
    room.players.forEach((p) => {
        io.to(p.id).emit('state_update', { ...gameState, myHand: room.hands[p.id] });
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));