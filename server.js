const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join_game', (data) => {
        // 대기 중인 플레이어가 있으면 매칭 시작
        if (waitingPlayer) {
            // 방 생성
            const roomName = waitingPlayer.id + "#" + socket.id;
            socket.join(roomName);
            waitingPlayer.join(roomName);

            // 두 플레이어에게 게임 시작 알림 (p1, p2 역할 지정)
            io.to(waitingPlayer.id).emit('game_start', { role: 'p1', room: roomName, opponentJob: data.job });
            io.to(socket.id).emit('game_start', { role: 'p2', room: roomName, opponentJob: waitingPlayer.job });

            waitingPlayer = null;
        } else {
            // 대기열에 등록
            waitingPlayer = socket;
            waitingPlayer.job = data.job; // 직업 정보 저장
            socket.emit('waiting');
        }
    });

    // 위치 및 상태 동기화 (릴레이)
    socket.on('player_update', (data) => {
        socket.broadcast.to(data.room).emit('opponent_update', data);
    });

    // 공격 이벤트 릴레이
    socket.on('attack_event', (data) => {
        socket.broadcast.to(data.room).emit('opponent_attack', data);
    });

    // 아이템 획득 릴레이
    socket.on('item_drop', (data) => {
        io.to(data.room).emit('spawn_item', data);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
        // 상대방에게 나갔음을 알림 (간단히 구현)
        socket.broadcast.emit('opponent_left');
    });
});

http.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});