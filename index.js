const REDIS_PORT = 6379;
const REDIS_HOST = "0.0.0.0";

const app = require('express')()
const server = require('http').createServer(app)
const io = require('socket.io')(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
})
const redis = require("redis");

server.listen(3030)

const redisClient = redis.createClient(REDIS_PORT, REDIS_HOST);

const state = {
  ready: 0,
  progress: 1,
  preEnd: 2,
  end: 3,
}

redisClient.on("error", function(error) {
  console.error(error);
});

io.on("connection", (socket) => {
  socket.on("join-game", (value) => {
    if(value.roomId == null || value.name == null) {
      socket.leaveAll()
      return
    }
    let tempRoomId = value.roomId

    socket.join(tempRoomId)
    console.log("join (" + tempRoomId + ") " + socket.id + "\n" + new Date());

    io.to(tempRoomId).clients((_, clients) => {
      if(clients.length === 1) {
        if(value.playerLimit == null) {
          socket.leaveAll()
          return
        }
        const playerLimit = value.playerLimit

        let roomObject = {}
        roomObject.roomId = tempRoomId
        roomObject.playerLimit = parseInt(playerLimit, 10);
        roomObject.players = [
          {id: socket.id, name: value.name, hands: [], plays: 0}
        ]
        roomObject.gameState = state.ready
        roomObject.gameTurnIndex = -1
        roomObject.minPlays = 2
        roomObject.deck = initDeck()
        roomObject.leads = {
          desc01: [],
          desc02: [],
          asc01: [],
          asc02: [],
        }

        redisClient.set(tempRoomId, JSON.stringify(roomObject), redis.print)
        io.to(tempRoomId).emit("game-ready", {
          roomObject: roomObject
        })
      } else {
        redisClient.get(tempRoomId, (err, roomValue) => {
          let roomObject = JSON.parse(roomValue);
          if(1 < clients.length && clients.length < roomObject.playerLimit) {
            roomObject.players.push({id: socket.id, name: value.name, hands: [], plays: 0})
            io.to(tempRoomId).emit("game-ready", {
              roomObject: roomObject
            })
            redisClient.set(tempRoomId, JSON.stringify(roomObject), redis.print)
          }
          else if(clients.length === roomObject.playerLimit) {
            roomObject.players.push({id: socket.id, name: value.name, hands: [], plays: 0})
            roomObject.players.forEach(player => {
              player.hands = roomObject.deck.splice(-5).sort(compareFunc)
            })
            roomObject.gameState = state.progress
            roomObject.gameTurnIndex = 0
            io.to(tempRoomId).emit("game-start", {
              roomObject: roomObject
            });
            redisClient.set(tempRoomId, JSON.stringify(roomObject), redis.print)
          }
          else {
            socket.leaveAll()
          }
        })
      }
    })
    socket.on("game-progress", (progressValue) => {
      const roomObject = progressValue.roomObject
      console.log(roomObject)

      const nextTurnIndex =  roomObject.gameTurnIndex === roomObject.playerLimit - 1 ? 0 : roomObject.gameTurnIndex + 1
      if(canPlay(roomObject, nextTurnIndex)) {
        let cardCount = 0
        roomObject.players.map(player => cardCount += player.hands.length)
        cardCount += roomObject.deck.length

        console.log(cardCount)

        if(cardCount <= 9 && roomObject.gameState === state.progress) {
          roomObject.gameState = state.preEnd

          io.to(roomObject.roomId).emit("game-end", {
            func: "preEnd"
          })
        } else if(cardCount === 0) {
          roomObject.gameState = state.end

          io.to(roomObject.roomId).emit("game-end", {
            func: "end"
          })
        }

        if(progressValue.func === "play") {
          roomObject.players[roomObject.gameTurnIndex].plays++

          io.to(roomObject.roomId).emit("game-update", {
            roomObject: roomObject,
            func: "update"
          })
        } else if(progressValue.func === "turn-end") {
          roomObject.players[roomObject.gameTurnIndex].hands = roomObject.players[roomObject.gameTurnIndex].hands.concat(roomObject.deck.splice(-roomObject.players[roomObject.gameTurnIndex].plays)).sort(compareFunc)
          roomObject.players[roomObject.gameTurnIndex].plays = 0
          roomObject.gameTurnIndex = nextTurnIndex

          if(roomObject.deck.length === 0) {
            roomObject.minPlays = 1
          }

          io.to(roomObject.roomId).emit("game-update", {
            roomObject: roomObject,
            func: "next-turn"
          })
        }
        redisClient.set(roomObject.roomId, JSON.stringify(roomObject), redis.print)
      } else {
        if(roomObject.gameState === state.preEnd) {
          io.to(roomObject.roomId).emit("game-end", {
            func: "preExitEnd"
          })
        } else {
          io.to(roomObject.roomId).emit("game-end", {
            func: "badEnd"
          })
        }
      }
    })
    socket.on("disconnect", (disconnectValue) => {
      io.to(tempRoomId).clients((_, clients) => {
        io.to(tempRoomId).emit("game-error", {
          msg: "他のプレイヤーが切断したためゲームを終了します。"
        });
        clients.disconnect
        redisClient.del(tempRoomId)
      })
    })
  })
})

function isPlay(playCardNumber, leadCardNumber, order) {
  if(order) {
    if(leadCardNumber == null)
      leadCardNumber = 100
    if((leadCardNumber > playCardNumber) || (playCardNumber === leadCardNumber + 10))
      return true
  } else {
    if(leadCardNumber == null)
      leadCardNumber = 1
    if((leadCardNumber < playCardNumber) || (playCardNumber === leadCardNumber - 10))
      return true
  }
  return false
}

function canPlay(roomObject, playerIndex) {
  let playCount = 0
  if(roomObject.players[playerIndex].hands.length === 0)
    return true

  roomObject.players[playerIndex].hands.forEach(function (x) {
    if(isPlay(x, roomObject.leads.desc01.slice(-1)[0], true) || isPlay(x, roomObject.leads.desc02.slice(-1)[0], true) || isPlay(x, roomObject.leads.asc01.slice(-1)[0], false) || isPlay(x, roomObject.leads.asc02.slice(-1)[0], false))
      playCount++
  })

  return playCount >= roomObject.minPlays
}

function initDeck() {
  const deck = Array.from(new Array(98)).map((v,i)=> i + 2)

  for(let i = deck.length - 1; i > 0; i--){
    const r = Math.floor(Math.random() * (i + 1));
    let tmp = deck[i];
    deck[i] = deck[r];
    deck[r] = tmp;
  }

  return deck
}

function compareFunc(a, b) {
  return a - b;
}

module.exports = app
