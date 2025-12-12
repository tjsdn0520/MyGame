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

    socket.on('join_game', (nickname) => {
        socket.nickname = nickname || '익명';
        waitingQueue.push(socket);
        waitingQueue.forEach(s => s.emit('waiting_status', waitingQueue.length));

        if (waitingQueue.length >= 4) {
            startGame();
        }
    });

    socket.on('draw_card', (data) => {
        const room = rooms[data.roomID];
        if (!room) return;

        const currentP = room.players[room.turnIndex];
        // 내 턴인지, 그리고 내가 탈출한 상태는 아닌지 체크
        if (socket.id !== currentP.id || room.hands[currentP.id].length === 0) return;

        // 타겟 찾기 (클라이언트에서 계산해서 보낸 타겟 인덱스 검증)
        let targetIdx = data.targetIndex;
        const targetP = room.players[targetIdx];
        const targetHand = room.hands[targetP.id];

        // 유효성 검사: 타겟에게 카드가 있어야 함
        if (!targetHand || targetHand.length === 0) {
            // 만약 클라가 잘못된 타겟을 보냈다면 서버가 다시 올바른 타겟(내 오른쪽 첫 번째 생존자)을 찾음
            targetIdx = (room.turnIndex + 1) % 4;
            while (room.hands[room.players[targetIdx].id].length === 0 && targetIdx !== room.turnIndex) {
                targetIdx = (targetIdx + 1) % 4;
            }
            // 다시 찾았는데도 없으면 게임 끝난 상황
            if (room.hands[room.players[targetIdx].id].length === 0) return;
        }

        // 카드 실제 이동
        let cardIdx = data.cardIndex;
        if (cardIdx >= targetHand.length) cardIdx = 0;
        const drawnCard = targetHand.splice(cardIdx, 1)[0];
        room.hands[currentP.id].push(drawnCard);

        // [중요] 뽑은 사람에게 "너 이거 뽑았어"라고 연출용 신호 보냄
        io.to(currentP.id).emit('card_drawn_animate', { card: drawnCard });

        // 페어 제거
        removePairs(room.hands[currentP.id]);

        io.to(room.roomID).emit('action_log', {
            msg: `${currentP.nickname}님이 ${targetP.nickname}님의 카드를 뽑았습니다.`
        });

        // 게임 종료 체크 (카드가 남은 사람이 1명 이하일 때)
        const survivors = room.players.filter(p => room.hands[p.id].length > 0);
        if (survivors.length <= 1) {
            const loser = survivors.length === 1 ? survivors[0].nickname : "오류";
            // 마지막 상태 업데이트 후 게임 종료 선언
            updateGameState(data.roomID);
            setTimeout(() => {
                 io.to(room.roomID).emit('game_over', { loser: loser });
                 delete rooms[data.roomID];
            }, 2500); // 클라이언트 애니메이션 시간만큼 기다렸다가 종료
            return;
        }

        // [중요] 턴 넘기기 로직 수정 (카드가 있는 다음 사람을 찾을 때까지 반복)
        let nextTurnIndex = (room.turnIndex + 1) % 4;
        // 내 다음 사람이 카드가 없으면 그 다음 사람으로... 반복
        while (room.hands[room.players[nextTurnIndex].id].length === 0) {
            nextTurnIndex = (nextTurnIndex + 1) % 4;
             // 무한루프 방지 (혹시 모를 상황 대비)
            if (nextTurnIndex === room.turnIndex) break; 
        }
        room.turnIndex = nextTurnIndex;

        // 상태 업데이트 전송
        updateGameState(data.roomID);
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(s => s !== socket);
    });
});

function startGame() {
    const players = waitingQueue.splice(0, 4);
    const roomID = 'room_' + Date.now();
    
    rooms[roomID] = {
        players: players,
        hands: {},
        turnIndex: 0
    };

    // 1~5(쌍) + 조커 (테스트용 적은 매수)
    let deck = ['🤡'];
    for(let i=1; i<=5; i++) { deck.push(i.toString()); deck.push(i.toString()); }
    deck.sort(() => Math.random() - 0.5);

    players.forEach(p => {
        p.join(roomID);
        rooms[roomID].hands[p.id] = [];
    });

    let dealIdx = 0;
    while(deck.length > 0) {
        rooms[roomID].hands[players[dealIdx].id].push(deck.pop());
        dealIdx = (dealIdx + 1) % 4;
    }

    // 시작 전 페어 제거
    players.forEach(p => removePairs(rooms[roomID].hands[p.id]));

    players.forEach((p, idx) => {
        io.to(p.id).emit('game_start', {
            roomID: roomID,
            myIndex: idx,
            players: players.map(pl => pl.nickname),
            hand: rooms[roomID].hands[p.id]
        });
    });

    // 첫 턴은 카드가 있는 첫 번째 사람부터
    let firstTurn = 0;
    while(rooms[roomID].hands[players[firstTurn].id].length === 0) {
        firstTurn = (firstTurn + 1) % 4;
    }
    rooms[roomID].turnIndex = firstTurn;

    updateGameState(roomID);
}

function removePairs(hand) {
    const counts = {};
    hand.forEach(c => counts[c] = (counts[c] || 0) + 1);
    const newHand = [];
    for (const card of hand) {
        // 홀수 개면 하나 남김, 짝수 개면 다 버림
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

function updateGameState(roomID) {
    const room = rooms[roomID];
    if(!room) return;
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