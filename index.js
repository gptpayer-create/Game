// index.js — Colyseus server entry point.
//
// Run locally:
//   npm install
//   npm start
//   -> ws://localhost:2567           (game connection)
//   -> http://localhost:2567/colyseus (built-in monitor dashboard)
//   -> http://localhost:2567/status   (tiny JSON status for the client's server browser)
//
// Deploy the SAME code to 3 regions (see ../README.md) to get your
// North America / Europe / India servers — this file doesn't change
// between regions, only which region you deploy it to.

const http = require('http');
const express = require('express');
const { Server } = require('colyseus');
const { monitor } = require('@colyseus/monitor');
const { TDMRoom, stats } = require('./TDMRoom');

const port = Number(process.env.PORT || 2567);

const app = express();
app.use(express.json());
app.use('/colyseus', monitor());

// The client's "server browser" screen polls this per-region to show a
// live "63/100" count next to each server card. Cheap and CORS-open on
// purpose since it's non-sensitive public info.
app.get('/status', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(stats);
});

const httpServer = http.createServer(app);
const gameServer = new Server({ server: httpServer });

gameServer.define('tdm', TDMRoom);

gameServer.listen(port);
console.log(`barrel.io server listening on ws://localhost:${port} (room: "tdm")`);
