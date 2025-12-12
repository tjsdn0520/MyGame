const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

let waitingQueue = [];
const rooms = {};

io.on('connection', (socket) => {
    console.log(`[접속] ${socket.id}`);

    // 게임 참가
    socket.on('join_game', (nickname) => {
        socket.nickname = nickname || '익명';
        waitingQueue.push(socket);
        waitingQueue.forEach(s => s.emit('waiting_status', waitingQueue.length));

        if (waitingQueue.length >= 4) {
            const players = waitingQueue.splice(0, 4);
            const roomID = 'room_' + Date.now();
            
            rooms[roomID] = {
                players: players,
                hands: {},
                turnIndex: 0,
                activePlayerCount: 4
            };

            // 1~5(쌍) + 조커
            let deck = ['🤡'];
            for(let i=1; i<=5; i++) { deck.push(i.toString()); deck.push(i.toString()); }
            deck.sort(() => Math.random() - 0.5);

            players.forEach((p, idx) => {
                p.join(roomID);
                rooms[roomID].hands[p.id] = [];
            });

            let dealIdx = 0;
            while(deck.length > 0) {
                rooms[roomID].hands[players[dealIdx].id].push(deck.pop());
                dealIdx = (dealIdx + 1) % 4;
            }

            players.forEach(p => removePairs(rooms[roomID].hands[p.id]));

            players.forEach((p, idx) => {
                io.to(p.id).emit('game_start', {
                    roomID: roomID,
                    myIndex: idx,
                    players: players.map(pl => pl.nickname),
                    hand: rooms[roomID].hands[p.id]
                });
            });

            updateGameState(roomID);
        }
    });

    // 카드 뽑기
    socket.on('draw_card', (data) => {
        const room = rooms[data.roomID];
        if (!room) return;

        const currentP = room.players[room.turnIndex];
        if (socket.id !== currentP.id) return;

        // [중요] 타겟 찾기 로직 (카드가 있는 다음 사람)
        let targetIdx = (room.turnIndex + 1) % 4;
        while (room.hands[room.players[targetIdx].id].length === 0) {
            targetIdx = (targetIdx + 1) % 4;
            if (targetIdx === room.turnIndex) break; // 혼자 남음 (방지)
        }

        const targetP = room.players[targetIdx];
        const targetHand = room.hands[targetP.id];

        if (targetHand.length === 0) return; // 예외 처리

        // 클라이언트가 보낸 인덱스가 유효한지 확인
        let cardIdx = data.cardIndex;
        if (cardIdx >= targetHand.length) cardIdx = 0;

        const drawnCard = targetHand.splice(cardIdx, 1)[0];
        room.hands[currentP.id].push(drawnCard);

        removePairs(room.hands[currentP.id]);

        io.to(room.roomID).emit('action_log', {
            msg: `${currentP.nickname}님이 ${targetP.nickname}님의 카드를 뽑았습니다.`
        });

        // 승리 체크
        checkWin(room, currentP);
        checkWin(room, targetP);

        // 게임 종료 체크 (1명 남음)
        const survivors = room.players.filter(p => room.hands[p.id].length > 0);
        if (survivors.length <= 1) {
            const loser = survivors.length === 1 ? survivors[0].nickname : "없음";
            io.to(room.roomID).emit('game_over', { loser: loser });
            delete rooms[data.roomID];
            return;
        }

        // 턴 넘기기 (카드가 있는 사람만 턴을 가질 수 있음)
        do {
            room.turnIndex = (room.turnIndex + 1) % 4;
        } while (room.hands[room.players[room.turnIndex].id].length === 0);

        updateGameState(data.roomID);
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(s => s !== socket);
    });
});

function removePairs(hand) {
    const counts = {};
    hand.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const newHand = [];
    for (const card of hand) {
        if (counts[card] % 2 !== 0) {
            newHand.push(card);
            counts[card]--;
        } else if (counts[card] > 0) {
            counts[card]--;
        }
    }
    hand.length = 0;
    hand.push(...newHand);
}

function checkWin(room, player) {
    // 이미 0장이 된 상태면 무시, 방금 0장이 된 경우 알림
    if (room.hands[player.id].length === 0) {
        // (간단하게 로그만 출력)
    }
}

function updateGameState(roomID) {
    const room = rooms[roomID];
    const gameState = {
        turnIndex: room.turnIndex,
        playerCounts: room.players.map(p => room.hands[p.id].length),
    };
    room.players.forEach((p) => {
        io.to(p.id).emit('state_update', {
            ...gameState,
            myHand: room.hands[p.id]
        });
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));