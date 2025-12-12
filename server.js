const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

let waitingQueue = [];
const rooms = {};

// 카드 덱 생성 함수 (Standard 52 + 1 Joker)
function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let deck = ['🤡JOKER']; // 조커 1장
    
    for (let s of suits) {
        for (let r of ranks) {
            deck.push(s + r); // 예: "♠A", "♥10"
        }
    }
    return deck;
}

// 숫자(Rank) 추출 함수 (예: "♠10" -> "10", "🤡JOKER" -> "JOKER")
function getRank(card) {
    if (card === '🤡JOKER') return 'JOKER';
    return card.substring(1); // 앞의 무늬 제외하고 나머지 리턴
}

io.on('connection', (socket) => {
    console.log(`[접속] ${socket.id}`);

    socket.on('join_game', (nickname) => {
        socket.nickname = nickname || '익명';
        waitingQueue.push(socket);
        // 대기열 상태 알림
        waitingQueue.forEach(s => s.emit('waiting_status', waitingQueue.length));

        // 4명 모이면 시작
        if (waitingQueue.length >= 4) {
            startGame();
        }
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
    
    rooms[roomID] = {
        players: players,
        hands: {},
        turnIndex: 0,
        timer: null,
        roomID: roomID
    };

    // 1. 덱 생성 및 셔플
    let deck = createDeck();
    deck.sort(() => Math.random() - 0.5);

    // 2. 방 입장 및 패 초기화
    players.forEach(p => {
        p.join(roomID);
        rooms[roomID].hands[p.id] = [];
    });

    // 3. 카드 분배 (한 장씩 돌아가며)
    let dealIdx = 0;
    while(deck.length > 0) {
        rooms[roomID].hands[players[dealIdx].id].push(deck.pop());
        dealIdx = (dealIdx + 1) % 4;
    }

    // 4. 초기 짝 맞추기 (버리기)
    players.forEach(p => removePairs(rooms[roomID].hands[p.id]));

    // 5. 게임 시작 신호
    players.forEach((p, idx) => {
        io.to(p.id).emit('game_start', {
            roomID: roomID,
            myIndex: idx,
            players: players.map(pl => pl.nickname),
            hand: rooms[roomID].hands[p.id]
        });
    });

    // 첫 턴 설정 (카드가 있는 첫 번째 사람)
    let firstTurn = 0;
    while(rooms[roomID].hands[players[firstTurn].id].length === 0) {
        firstTurn = (firstTurn + 1) % 4;
    }
    rooms[roomID].turnIndex = firstTurn;

    updateGameState(roomID);
    startTurnTimer(roomID);
}

function processDrawCard(roomID, playerID, targetIdx, cardIdx) {
    const room = rooms[roomID];
    if (!room) return;

    clearTimeout(room.timer); // 타이머 멈춤

    const currentP = room.players[room.turnIndex];
    
    // 유효성 검사: 내 턴인가? 탈출하진 않았는가?
    if (playerID !== currentP.id || room.hands[currentP.id].length === 0) return;

    // 타겟 자동 보정 (지정 안됐거나, 카드가 없는 경우)
    let validTargetIdx = targetIdx;
    if (validTargetIdx === undefined || validTargetIdx === null || room.hands[room.players[validTargetIdx].id].length === 0) {
        validTargetIdx = (room.turnIndex + 1) % 4;
        // 카드가 있는 가장 가까운 오른쪽 사람 찾기
        while (room.hands[room.players[validTargetIdx].id].length === 0 && validTargetIdx !== room.turnIndex) {
            validTargetIdx = (validTargetIdx + 1) % 4;
        }
    }

    const targetP = room.players[validTargetIdx];
    const targetHand = room.hands[targetP.id];

    if (targetHand.length === 0) return; // 게임 종료 임박 등 예외

    // 카드 인덱스 랜덤 처리 (범위 밖이거나 null일 때)
    if (cardIdx === undefined || cardIdx === null || cardIdx >= targetHand.length) {
        cardIdx = Math.floor(Math.random() * targetHand.length);
    }

    // 카드 이동
    const drawnCard = targetHand.splice(cardIdx, 1)[0];
    const rank = getRank(drawnCard);
    
    // 페어 여부 확인 (내 손에 같은 숫자가 있는지)
    const isPair = room.hands[currentP.id].some(c => getRank(c) === rank);
    
    room.hands[currentP.id].push(drawnCard);

    // 뽑은 사람에게 결과 전송 (애니메이션용)
    io.to(currentP.id).emit('card_drawn_animate', { 
        card: drawnCard, 
        isPair: isPair 
    });

    // 짝 제거 실행
    removePairs(room.hands[currentP.id]);

    io.to(room.roomID).emit('action_log', {
        msg: `${currentP.nickname}님이 ${targetP.nickname}님의 카드를 뽑았습니다.`
    });

    // 종료 조건: 조커를 가진 1명만 남았을 때
    const survivors = room.players.filter(p => room.hands[p.id].length > 0);
    if (survivors.length <= 1) {
        const loser = survivors.length === 1 ? survivors[0].nickname : "오류";
        updateGameState(roomID);
        // 연출 시간 확보 후 종료
        setTimeout(() => {
             io.to(room.roomID).emit('game_over', { loser: loser });
             delete rooms[roomID];
        }, 3000);
        return;
    }

    // 턴 넘기기 (카드가 있는 다음 사람)
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

    // 10초 타이머 설정
    io.to(roomID).emit('timer_reset', { duration: 10 });

    room.timer = setTimeout(() => {
        const currentPlayer = room.players[room.turnIndex];
        // 시간 초과 시 자동 뽑기 (타겟, 카드 랜덤)
        processDrawCard(roomID, currentPlayer.id, null, null); 
    }, 10000);
}

// 짝 제거 함수 (Rank 기준)
function removePairs(hand) {
    const counts = {};
    // 숫자별로 개수 세기
    hand.forEach(c => {
        const rank = getRank(c);
        counts[rank] = (counts[rank] || 0) + 1;
    });

    const newHand = [];
    for (const card of hand) {
        const rank = getRank(card);
        // 홀수 개면 1장 남김 (3장이면 1쌍 버리고 1장 남음)
        if (counts[rank] % 2 !== 0) {
            newHand.push(card);
            counts[rank]--; // 처리 표시
        } else if (counts[rank] > 0) {
            // 짝수 개면 모두 버림 (카운트만 감소)
            counts[rank]--;
        }
    }
    // 배열 교체
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