const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// 현재 폴더의 모든 파일(이미지, html 등)을 클라이언트에 제공
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 대기 중인 플레이어 (매칭용)
let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 게임 참여 요청
    socket.on('join_game', (data) => {
        if (waitingPlayer) {
            // 매칭 성사 -> 방 생성
            const roomName = waitingPlayer.id + "#" + socket.id;
            socket.join(roomName);
            waitingPlayer.join(roomName);

            // 두 명에게 게임 시작 신호
            io.to(waitingPlayer.id).emit('game_start', { 
                role: 'p1', 
                room: roomName, 
                opponentJob: data.job 
            });
            io.to(socket.id).emit('game_start', { 
                role: 'p2', 
                room: roomName, 
                opponentJob: waitingPlayer.job 
            });

            waitingPlayer = null; // 대기열 초기화
        } else {
            // 대기열 등록
            waitingPlayer = socket;
            waitingPlayer.job = data.job;
            socket.emit('waiting');
        }
    });

    // 플레이어 움직임/상태 동기화
    socket.on('player_update', (data) => {
        // 같은 방의 다른 사람에게만 전송 (broadcast)
        socket.broadcast.to(data.room).emit('opponent_update', data);
    });

    // 공격 이벤트 전달
    socket.on('attack_event', (data) => {
        socket.broadcast.to(data.room).emit('opponent_attack', data);
    });

    // 연결 종료 처리
    socket.on('disconnect', () => {
        console.log('User disconnected');
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
        // 상대방에게 나갔음을 알림
        socket.broadcast.emit('opponent_left');
    });
});

// Render에서는 process.env.PORT를 사용해야 함 (없으면 3000)
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});