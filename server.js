const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {cors:{origin:'*'}});
const PORT = process.env.PORT || 3000;
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));

const STORE_FILE = path.join(__dirname, 'data_store.json');
let persistent = {rooms: {}, stats: {}};
try{
  if(fs.existsSync(STORE_FILE)) persistent = JSON.parse(fs.readFileSync(STORE_FILE));
}catch(e){ console.error('load store err', e); }

const rooms = {}; // runtime rooms

function saveStore(){
  try{ fs.writeFileSync(STORE_FILE, JSON.stringify(persistent, null,2)); }catch(e){ console.error('save err', e); }
}

function generateCode(len=6){
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for(let i=0;i<len;i++) s += chars.charAt(Math.floor(Math.random()*chars.length));
  return s;
}

function createRoomObject(hostSocketId, hostName){
  const code = generateCode(6);
  const room = {
    code,
    players: {},
    host: hostSocketId,
    state: 'lobby',
    settings: {
      dayTime: 60,
      nightTime: 30,
      roles: ['werewolf','seer','witch','guard','villager','villager']
    },
    votes: {},
    nightActions: {},
    lastProtected: null,
    botIds: []
  };
  room.players[hostSocketId] = {id: hostSocketId, name: hostName, alive:true, role:null, ready:false, isBot:false, potions:{heal:true,poison:true}};
  rooms[code] = room;
  persistent.rooms[code] = {created: Date.now(), settings: room.settings};
  saveStore();
  return room;
}

function assignRoles(room){
  const pids = Object.keys(room.players);
  let roles = room.settings.roles.slice();
  if(roles.length < pids.length){
    while(roles.length < pids.length) roles.push('villager');
  } else if(roles.length > pids.length){
    roles = roles.slice(0, pids.length);
  }
  for(let i=roles.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  pids.forEach((id, idx)=>{
    room.players[id].role = roles[idx];
    room.players[id].alive = true;
    room.players[id].potions = room.players[id].potions || {heal:true,poison:true};
  });
}

function simpleBotAction(room, botId){
  const bot = room.players[botId];
  if(!bot || !bot.alive) return;
  if(room.state === 'night'){
    if(bot.role === 'werewolf'){
      const targets = Object.values(room.players).filter(p=>p.alive && p.role !== 'werewolf').map(p=>p.id);
      if(targets.length) room.nightActions[botId] = {type:'kill', target: targets[Math.floor(Math.random()*targets.length)]};
    } else if(bot.role === 'seer'){
      const targets = Object.values(room.players).filter(p=>p.alive && p.id !== botId).map(p=>p.id);
      if(targets.length) room.nightActions[botId] = {type:'inspect', target: targets[Math.floor(Math.random()*targets.length)], _from: botId};
    } else if(bot.role === 'witch'){
      if(bot.potions && bot.potions.heal && Math.random() < 0.3){
        if(room._lastNightKill) room.nightActions[botId] = {type:'heal', target: room._lastNightKill};
      } else if(bot.potions && bot.potions.poison && Math.random() < 0.2){
        const targets = Object.values(room.players).filter(p=>p.alive && p.id !== botId).map(p=>p.id);
        if(targets.length) room.nightActions[botId] = {type:'poison', target: targets[Math.floor(Math.random()*targets.length)]};
      }
    } else if(bot.role === 'guard'){
      const targets = Object.values(room.players).filter(p=>p.alive).map(p=>p.id);
      if(targets.length) room.nightActions[botId] = {type:'protect', target: targets[Math.floor(Math.random()*targets.length)]};
    }
  } else if(room.state === 'day'){
    const targets = Object.values(room.players).filter(p=>p.alive && p.id !== botId).map(p=>p.id);
    if(targets.length) room.votes[botId] = targets[Math.floor(Math.random()*targets.length)];
  }
}

io.on('connection', (socket) => {
  console.log('conn', socket.id);

  socket.on('createRoom', ({name}, cb) => {
    const room = createRoomObject(socket.id, name || 'لاعب');
    socket.join(room.code);
    cb({ok:true, code: room.code});
    io.to(room.code).emit('roomUpdate', room);
  });

  socket.on('joinRoom', ({code, name}, cb) => {
    const room = rooms[code];
    if(!room) return cb({ok:false, error:'رمز الغرفة غير صحيح'});
    socket.join(code);
    room.players[socket.id] = {id: socket.id, name:name||'لاعب', alive:true, role:null, ready:false, isBot:false, potions:{heal:true,poison:true}};
    cb({ok:true});
    io.to(code).emit('roomUpdate', room);
  });

  socket.on('becomeBot', ({code, botName}, cb) => {
    const room = rooms[code];
    if(!room) return cb({ok:false});
    const botId = 'bot_' + Math.random().toString(36).slice(2,9);
    room.players[botId] = {id: botId, name: botName||'بوت', alive:true, role:null, ready:true, isBot:true, potions:{heal:true,poison:true}};
    room.botIds.push(botId);
    io.to(code).emit('roomUpdate', room);
    cb({ok:true});
  });

  socket.on('leaveRoom', ({code})=>{
    const room = rooms[code];
    if(!room) return;
    delete room.players[socket.id];
    socket.leave(code);
    if(Object.keys(room.players).length===0){
      delete rooms[code];
      delete persistent.rooms[code];
      saveStore();
    } else {
      if(room.host === socket.id){
        room.host = Object.keys(room.players)[0];
      }
      io.to(code).emit('roomUpdate', room);
    }
  });

  socket.on('setReady', ({code, ready})=>{
    const room = rooms[code];
    if(!room) return;
    if(room.players[socket.id]) room.players[socket.id].ready = ready;
    io.to(code).emit('roomUpdate', room);
  });

  socket.on('updateSettings', ({code, settings}, cb)=>{
    const room = rooms[code];
    if(!room) return cb({ok:false});
    if(room.host !== socket.id) return cb({ok:false, error:'فقط المضيف يستطيع تغيير الإعدادات'});
    room.settings = Object.assign(room.settings, settings);
    persistent.rooms[code] = {created: Date.now(), settings: room.settings};
    saveStore();
    io.to(code).emit('roomUpdate', room);
    cb({ok:true});
  });

  socket.on('startGame', ({code}, cb)=>{
    const room = rooms[code];
    if(!room) return cb({ok:false, error:'غرفة غير موجودة'});
    const pcount = Object.keys(room.players).length;
    if(pcount < 4) return cb({ok:false, error:'الحاجة على الأقل 4 لاعبين'});
    assignRoles(room);
    room.state = 'night';
    room.votes = {};
    room.nightActions = {};
    room._lastNightKill = null;
    io.to(code).emit('roomUpdate', room);
    Object.values(room.players).forEach(p=>{
      if(p.isBot) return;
      io.to(p.id).emit('yourRole', {role: p.role});
    });
    cb({ok:true});
    startPhaseTimer(code);
    room.botIds.forEach(bid=> simpleBotAction(room, bid));
  });

  socket.on('nightAction', ({code, action}, cb)=>{
    const room = rooms[code];
    if(!room) return cb && cb({ok:false});
    room.nightActions[socket.id] = action;
    cb && cb({ok:true});
  });

  socket.on('chat', ({code, msg})=>{
    if(!rooms[code]) return;
    io.to(code).emit('chat', {from: socket.id, msg, name: rooms[code]?.players[socket.id]?.name||'لاعب'});
  });

  socket.on('vote', ({code, target})=>{
    const room = rooms[code];
    if(!room) return;
    room.votes[socket.id] = target;
    io.to(code).emit('votesUpdate', Object.keys(room.votes).length);
  });

  socket.on('disconnect', ()=>{
    for(const code in rooms){
      const room = rooms[code];
      if(room.players[socket.id]){
        const leaving = room.players[socket.id];
        delete room.players[socket.id];
        if(room.state !== 'lobby'){
          const botId = 'bot_' + Math.random().toString(36).slice(2,9);
          const bot = {id: botId, name: leaving.name + ' (بوت)', alive: leaving.alive, role: leaving.role, ready:true, isBot:true, potions: leaving.potions || {heal:true,poison:true}};
          room.players[botId] = bot;
          room.botIds.push(botId);
          simpleBotAction(room, botId);
        }
        io.to(code).emit('roomUpdate', room);
      }
      if(Object.keys(room.players).length===0){
        delete rooms[code];
        delete persistent.rooms[code];
        saveStore();
      }
    }
  });

  function startPhaseTimer(code){
    const room = rooms[code];
    if(!room) return;
    const duration = room.state === 'night' ? room.settings.nightTime : room.settings.dayTime;
    io.to(code).emit('phaseStarted', {phase: room.state, duration});
    room.botIds.forEach(bid=> simpleBotAction(room, bid));
    setTimeout(()=>{
      if(room.state === 'day'){
        const counts = {};
        Object.values(room.votes).forEach(v=>{ if(v) counts[v] = (counts[v]||0)+1; });
        let max=0, target=null;
        for(const k in counts){ if(counts[k]>max){ max=counts[k]; target=k; } }
        if(target && room.players[target]) room.players[target].alive = false;
        room.votes = {};
        if(checkEnd(code)) return;
        room.state = 'night';
      } else {
        const protects = Object.values(room.nightActions).filter(a=>a.type==='protect').map(a=>a.target);
        const protectedTarget = protects.length ? protects[0] : null;
        room.lastProtected = protectedTarget;
        const kills = Object.values(room.nightActions).filter(a=>a.type==='kill').map(a=>a.target);
        const killCounts = {};
        kills.forEach(t=> killCounts[t] = (killCounts[t]||0)+1);
        let max=0, killTarget=null;
        for(const k in killCounts){ if(killCounts[k]>max){ max=killCounts[k]; killTarget=k; } }
        const inspections = Object.entries(room.nightActions).filter(([k,a])=>a.type==='inspect').map(([k,a])=> ({from:k, target:a.target}));
        inspections.forEach(ins=>{
          const target = room.players[ins.target];
          if(target && !target.isBot){
            io.to(ins.from).emit('inspectResult', {target: ins.target, role: target.role});
          }
        });
        room._lastNightKill = null;
        if(killTarget && room.players[killTarget]){
          if(killTarget === protectedTarget){
          } else {
            room.players[killTarget].alive = false;
            room._lastNightKill = killTarget;
          }
        }
        const witches = Object.entries(room.nightActions).filter(([k,a])=>a.type==='heal' || a.type==='poison').map(([k,a])=> a);
        witches.forEach(w=>{
          const witchPlayer = Object.values(room.players).find(p=>p.role==='witch');
          if(!witchPlayer) return;
          if(w.type==='heal' && witchPlayer.potions && witchPlayer.potions.heal){
            if(w.target && room._lastNightKill === w.target){
              room.players[w.target].alive = true;
              room._lastNightKill = null;
              witchPlayer.potions.heal = false;
            } else if(room._lastNightKill){
              // if heal but target null, heal last kill
              room.players[room._lastNightKill].alive = true;
              room._lastNightKill = null;
              witchPlayer.potions.heal = false;
            }
          } else if(w.type==='poison' && witchPlayer.potions && witchPlayer.potions.poison){
            if(w.target && room.players[w.target]){ room.players[w.target].alive = false; witchPlayer.potions.poison = false; }
          }
        });

        room.nightActions = {};
        if(checkEnd(code)) return;
        room.state = 'day';
      }
      io.to(code).emit('roomUpdate', room);
      startPhaseTimer(code);
    }, (duration||10)*1000);
  }

  function checkEnd(code){
    const room = rooms[code];
    if(!room) return true;
    const alive = Object.values(room.players).filter(p=>p.alive);
    const wolves = alive.filter(p=>p.role === 'werewolf').length;
    const villagers = alive.length - wolves;
    if(wolves === 0){
      io.to(code).emit('gameOver', {winner: 'القرويون'});
      room.state = 'ended';
      persistent.stats[code] = persistent.stats[code] || {games:0};
      persistent.stats[code].games += 1;
      saveStore();
      return true;
    } else if(wolves >= villagers){
      io.to(code).emit('gameOver', {winner: 'الذئاب'});
      room.state = 'ended';
      persistent.stats[code] = persistent.stats[code] || {games:0};
      persistent.stats[code].games += 1;
      saveStore();
      return true;
    }
    return false;
  }

});

http.listen(PORT, ()=> console.log('listening', PORT));
