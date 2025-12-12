const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let waitingPlayer = null;
const rooms = {};

io.on('connection', (socket) => {
    console.log(`[접속] 유저 연결됨: ${socket.id}`);

    socket.on('join_game', () => {
        if (waitingPlayer) {
            // === 매칭 성사 ===
            const roomID = waitingPlayer.id + "#" + socket.id;
            const p1 = waitingPlayer;
            const p2 = socket;

            if (p1.id === p2.id) {
                console.log(`[오류] 자기 자신과 매칭되려 함 (새로고침 필요)`);
                return;
            }

            p1.join(roomID);
            p2.join(roomID);

            rooms[roomID] = {
                p1: p1,
                p2: p2,
                moves: {},
                timer: null
            };

            console.log(`[매칭 성공] 방 생성됨: ${roomID}`);
            console.log(` - 플레이어 1: ${p1.id}`);
            console.log(` - 플레이어 2: ${p2.id}`);

            io.to(roomID).emit('game_start', { roomID: roomID });
            startRound(roomID);

            waitingPlayer = null;
        } else {
            // === 대기열 등록 ===
            waitingPlayer = socket;
            console.log(`[대기] 유저 대기열 등록: ${socket.id}`);
            socket.emit('waiting');
        }
    });

    socket.on('make_move', (data) => {
        // 로그 출력: 누가 무엇을 냈나?
        console.log(`[선택] 유저(${socket.id})가 선택함: ${data.choice} (방: ${data.roomID})`);

        const room = rooms[data.roomID];
        if (!room) {
            console.log(`[오류] 방을 찾을 수 없음: ${data.roomID}`);
            return;
        }

        // 이미 냈으면 무시
        if (room.moves[socket.id]) {
            console.log(`[중복] 이미 선택한 유저입니다.`);
            return;
        }

        room.moves[socket.id] = data.choice;

        // 두 명 다 냈는지 체크
        const p1Choice = room.moves[room.p1.id];
        const p2Choice = room.moves[room.p2.id];

        console.log(`[현황] P1 선택: ${p1Choice || '미정'} / P2 선택: ${p2Choice || '미정'}`);

        if (p1Choice && p2Choice) {
            console.log(`[결과] 두 명 모두 선택 완료! 판정 시작.`);
            clearTimeout(room.timer);
            determineWinner(room.p1, room.p2, room.moves, data.roomID);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[퇴장] 유저 연결 끊김: ${socket.id}`);
        if (waitingPlayer === socket) {
            waitingPlayer = null;
            console.log(`[대기열] 대기하던 유저가 나가서 대기열 초기화.`);
        }
    });
});

function startRound(roomID) {
    const room = rooms[roomID];
    if (!room) return;

    console.log(`[타이머] ${roomID} 방 10초 카운트 시작`);

    room.timer = setTimeout(() => {
        if (!rooms[roomID]) return; // 이미 게임 끝났으면 패스

        console.log(`[타이머 종료] 10초 경과. 결과 판정.`);
        
        const m1 = room.moves[room.p1.id];
        const m2 = room.moves[room.p2.id];

        if (!m1 && !m2) {
            io.to(roomID).emit('game_result', { result: 'draw', msg: '둘 다 미선택 (무승부)' });
        } else if (!m1) {
            room.p1.emit('game_result', { result: 'lose', msg: '시간 초과!' });
            room.p2.emit('game_result', { result: 'win', msg: '상대방 시간 초과!', opponentMove: 'timeout' });
        } else if (!m2) {
            room.p2.emit('game_result', { result: 'lose', msg: '시간 초과!' });
            room.p1.emit('game_result', { result: 'win', msg: '상대방 시간 초과!', opponentMove: 'timeout' });
        }
        
        // 게임 정보 삭제
        delete rooms[roomID];
    }, 10000);
}

function determineWinner(p1, p2, moves, roomID) {
    const m1 = moves[p1.id];
    const m2 = moves[p2.id];

    let res1 = '';
    let res2 = '';

    if (m1 === m2) {
        res1 = 'draw'; res2 = 'draw';
    } else if (
        (m1 === 'rock' && m2 === 'scissors') ||
        (m1 === 'paper' && m2 === 'rock') ||
        (m1 === 'scissors' && m2 === 'paper')
    ) {
        res1 = 'win'; res2 = 'lose';
    } else {
        res1 = 'lose'; res2 = 'win';
    }

    console.log(`[승패] P1(${m1}) vs P2(${m2}) -> P1 결과: ${res1}`);

    p1.emit('game_result', { result: res1, opponentMove: m2 });
    p2.emit('game_result', { result: res2, opponentMove: m1 });

    delete rooms[roomID];
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});