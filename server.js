const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

let waitingQueue = []; // 대기열
const rooms = {}; // 방 정보

io.on('connection', (socket) => {
    console.log(`[접속] ${socket.id}`);

    // 게임 참가 요청
    socket.on('join_game', (nickname) => {
        socket.nickname = nickname || '익명';
        waitingQueue.push(socket);
        
        // 대기 중인 사람들에게 현재 인원수 알림
        waitingQueue.forEach(s => s.emit('waiting_status', waitingQueue.length));

        // 4명이 모이면 게임 시작
        if (waitingQueue.length >= 4) {
            const players = waitingQueue.splice(0, 4); // 4명 추출
            const roomID = 'room_' + Date.now();
            
            // 방 데이터 생성
            rooms[roomID] = {
                players: players,
                hands: {}, // 플레이어별 카드
                turnIndex: 0, // 현재 턴 (0~3)
                finishedCount: 0 // 탈출한 사람 수
            };

            // 1. 카드 덱 생성 (1~5 숫자쌍 + 조커)
            let deck = ['🤡'];
            for(let i=1; i<=5; i++) { deck.push(i.toString()); deck.push(i.toString()); }
            
            // 2. 셔플
            deck.sort(() => Math.random() - 0.5);

            // 3. 카드 분배 및 방 입장
            players.forEach((p, idx) => {
                p.join(roomID);
                rooms[roomID].hands[p.id] = [];
            });

            // 한 장씩 나눠주기
            let dealIdx = 0;
            while(deck.length > 0) {
                rooms[roomID].hands[players[dealIdx].id].push(deck.pop());
                dealIdx = (dealIdx + 1) % 4;
            }

            // 4. 초기 중복 제거 (페어 버리기)
            players.forEach(p => {
                removePairs(rooms[roomID].hands[p.id]);
            });

            // 5. 게임 시작 신호 전송
            players.forEach((p, idx) => {
                io.to(p.id).emit('game_start', {
                    roomID: roomID,
                    myIndex: idx,
                    players: players.map(pl => pl.nickname),
                    hand: rooms[roomID].hands[p.id]
                });
            });

            // 첫 턴 정보 전송
            updateGameState(roomID);
        }
    });

    // 카드 뽑기 요청
    socket.on('draw_card', (data) => {
        const room = rooms[data.roomID];
        if (!room) return;

        const currentP = room.players[room.turnIndex]; // 뽑는 사람
        // 내 턴이 아니면 무시
        if (socket.id !== currentP.id) return;

        // 다음 사람(타겟) 찾기 (카드가 있는 사람을 찾을 때까지 건너뜀)
        let targetIdx = (room.turnIndex + 1) % 4;
        while (room.hands[room.players[targetIdx].id].length === 0) {
            targetIdx = (targetIdx + 1) % 4;
            // 만약 나 혼자 남았거나(게임끝) 에러 방지
            if (targetIdx === room.turnIndex) break; 
        }

        const targetP = room.players[targetIdx];
        const targetHand = room.hands[targetP.id];

        // 타겟의 카드 중 선택한 인덱스 (유효성 검사)
        let cardIdx = data.cardIndex;
        if (cardIdx >= targetHand.length) cardIdx = 0; // 에러 방지

        // 카드 이동
        const drawnCard = targetHand.splice(cardIdx, 1)[0]; // 뽑아가기
        room.hands[currentP.id].push(drawnCard); // 내 손에 추가

        // 페어 확인 및 제거
        const isPair = removePairs(room.hands[currentP.id]);

        // 결과 전송
        io.to(room.roomID).emit('action_log', {
            msg: `${currentP.nickname}님이 ${targetP.nickname}님의 카드를 뽑았습니다.`
        });

        // 승리(탈출) 체크
        checkWin(room, currentP);
        checkWin(room, targetP);

        // 게임 종료 체크 (1명 남았을 때)
        const survivors = room.players.filter(p => room.hands[p.id].length > 0);
        if (survivors.length === 1) {
            io.to(room.roomID).emit('game_over', { loser: survivors[0].nickname });
            delete rooms[data.roomID];
            return;
        }

        // 턴 넘기기 (카드가 있는 다음 사람에게)
        do {
            room.turnIndex = (room.turnIndex + 1) % 4;
        } while (room.hands[room.players[room.turnIndex].id].length === 0);

        updateGameState(data.roomID);
    });

    socket.on('disconnect', () => {
        // 대기열에서 삭제
        waitingQueue = waitingQueue.filter(s => s !== socket);
    });
});

// 중복 카드 제거 함수
function removePairs(hand) {
    const counts = {};
    hand.forEach(c => counts[c] = (counts[c] || 0) + 1);
    
    let newHand = [];
    let pairFound = false;
    for (const card of hand) {
        if (counts[card] % 2 !== 0) {
            newHand.push(card);
            counts[card]--; // 처리됨
        } else if (counts[card] > 0) {
            // 짝수개면 버림 (카운트만 줄임)
            counts[card]--;
            pairFound = true;
        }
    }
    // 배열 내용을 교체
    hand.length = 0;
    hand.push(...newHand);
    return pairFound;
}

// 승리(탈출) 체크
function checkWin(room, player) {
    if (room.hands[player.id].length === 0) {
        // 이미 탈출한 사람은 제외
        // (간단 구현을 위해 로그만 전송, 로직은 턴 스킵으로 처리됨)
        io.to(room.roomID).emit('action_log', { msg: `🎉 ${player.nickname}님 탈출 성공!` });
    }
}

// 모든 플레이어에게 현재 상태 전송 (카드가 몇 장 남았는지 등)
function updateGameState(roomID) {
    const room = rooms[roomID];
    const gameState = {
        turnIndex: room.turnIndex, // 누구 턴인지
        playerCounts: room.players.map(p => room.hands[p.id].length), // 각자 몇 장인지
    };

    // 각자에게는 자기 패를 보여줌
    room.players.forEach((p) => {
        io.to(p.id).emit('state_update', {
            ...gameState,
            myHand: room.hands[p.id]
        });
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));