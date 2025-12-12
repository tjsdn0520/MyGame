const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 대기 중인 플레이어
let waitingPlayer = null;
// 방 정보 저장 { roomID: { p1: socket, p2: socket, moves: {}, timer: null } }
const rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join_game', () => {
        if (waitingPlayer) {
            // 매칭 성사
            const roomID = waitingPlayer.id + "#" + socket.id;
            const p1 = waitingPlayer;
            const p2 = socket;

            p1.join(roomID);
            p2.join(roomID);

            // 방 데이터 생성
            rooms[roomID] = {
                p1: p1,
                p2: p2,
                moves: {}, // 플레이어의 선택 저장 (가위/바위/보)
                timer: null // 타이머 ID
            };

            // 게임 시작 신호 전송
            io.to(roomID).emit('game_start', { roomID: roomID });
            
            // 라운드 시작 (타이머 가동)
            startRound(roomID);

            waitingPlayer = null;
        } else {
            // 대기열 등록
            waitingPlayer = socket;
            socket.emit('waiting');
        }
    });

    // 플레이어가 가위/바위/보 선택
    socket.on('make_move', (data) => {
        const room = rooms[data.roomID];
        if (!room) return;

        // 이미 선택했으면 무시
        if (room.moves[socket.id]) return;

        // 선택 저장
        room.moves[socket.id] = data.choice; // 'rock', 'paper', 'scissors'

        // 두 명 다 선택했는지 확인
        if (room.moves[room.p1.id] && room.moves[room.p2.id]) {
            clearTimeout(room.timer); // 타이머 중지
            determineWinner(room.p1, room.p2, room.moves, data.roomID);
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
        // 게임 중 나갔을 때 처리 로직은 생략 (간단하게)
    });
});

// 라운드 시작 및 타임아웃 처리 함수
function startRound(roomID) {
    const room = rooms[roomID];
    if (!room) return;

    // 10초 카운트다운 시작 (서버 기준)
    room.timer = setTimeout(() => {
        // 10초가 지났을 때 실행
        const m1 = room.moves[room.p1.id];
        const m2 = room.moves[room.p2.id];

        if (!m1 && !m2) {
            // 둘 다 안 냄 -> 무승부 처리
            io.to(roomID).emit('game_result', { result: 'draw', msg: '둘 다 시간 초과! 무승부' });
        } else if (!m1) {
            // P1이 안 냄 -> P1 패배, P2 승리
            room.p1.emit('game_result', { result: 'lose', msg: '시간 초과! 패배했습니다.' });
            room.p2.emit('game_result', { result: 'win', msg: '상대방 시간 초과! 승리했습니다.', opponentMove: 'timeout' });
        } else if (!m2) {
            // P2가 안 냄 -> P2 패배, P1 승리
            room.p2.emit('game_result', { result: 'lose', msg: '시간 초과! 패배했습니다.' });
            room.p1.emit('game_result', { result: 'win', msg: '상대방 시간 초과! 승리했습니다.', opponentMove: 'timeout' });
        }
        // 둘 다 냈으면 이미 make_move에서 처리됨
        
        delete rooms[roomID]; // 게임 종료 후 방 삭제
    }, 10000); // 10000ms = 10초
}

// 승패 판정 로직
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

    p1.emit('game_result', { result: res1, opponentMove: m2 });
    p2.emit('game_result', { result: res2, opponentMove: m1 });

    delete rooms[roomID];
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});