"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const express = require("express");
const app = express();
const mongo = require("mongodb");
const queries_1 = require("./queries");
const chalk = require("chalk");
const cors = require("cors");
process.on('message', (m, socket) => __awaiter(void 0, void 0, void 0, function* () {
    console.log('message received!', m, socket);
    if (m === 'socket') {
        console.log('m is socket');
        switch (socket.type) {
            case 'block':
                console.log('current block is now', socket.block);
        }
    }
}));
const start = function () {
    return __awaiter(this, void 0, void 0, function* () {
        console.log(chalk.magenta('PLANARIUM'), chalk.cyan('initializing machine...'));
        app.set('port', process.env.PORT || 3000);
        app.set('host', process.env.HOST || 'localhost');
        app.set('view engine', 'ejs');
        app.set('views', __dirname + '/views');
        app.use(cors());
        app.use(express.static(__dirname + '/public'));
        app.get(/^\/q\/(.+)$/, function (req, res) {
            let b64 = req.params[0];
            console.log(chalk.magenta('PLANARIUM'), chalk.cyan('query', b64));
            mongo.MongoClient.connect(process.env.MONGO_URL, {
                useUnifiedTopology: true,
                useNewUrlParser: true,
            }, function (err, db) {
                return __awaiter(this, void 0, void 0, function* () {
                    if (err)
                        throw err;
                    var dbo = db.db('bmap');
                    let code = Buffer.from(b64, 'base64').toString();
                    let req = JSON.parse(code);
                    if (req.q.aggregate) {
                        dbo
                            .collection('c')
                            .aggregate(req.q.aggregate)
                            .sort(req.q.sort || { _id: -1 })
                            .limit(req.q.limit ? req.q.limit : 10)
                            .toArray(function (err, c) {
                            if (err)
                                throw err;
                            dbo
                                .collection('u')
                                .aggregate(req.q.aggregate)
                                .sort(req.q.sort || { _id: -1 })
                                .limit(req.q.limit ? req.q.limit : 10)
                                .toArray(function (err, u) {
                                db.close();
                                res.send({ c: c, u: u });
                            });
                        });
                        return;
                    }
                    dbo
                        .collection('c')
                        .find(req.q.find)
                        .sort(req.q.sort || { _id: -1 })
                        .limit(req.q.hasOwnProperty('limit') ? req.q.limit : 10)
                        .project(req.q.project || { in: 0, out: 0 })
                        .toArray(function (err, c) {
                        if (err)
                            throw err;
                        dbo
                            .collection('u')
                            .find(req.q.find)
                            .sort(req.q.sort || { _id: -1 })
                            .limit(req.q.hasOwnProperty('limit') ? req.q.limit : 10)
                            .project(req.q.project || { in: 0, out: 0 })
                            .toArray(function (err, u) {
                            db.close();
                            res.send({ c: c, u: u });
                        });
                    });
                });
            });
        });
        app.get('/ping', (req, res) => __awaiter(this, void 0, void 0, function* () {
            if (req.get('Referrer')) {
                console.log({
                    level: 'info',
                    message: 'Referrer: ' + req.get('Referrer'),
                });
            }
            res.write(JSON.stringify({ Pong: req.get('Referrer') }));
            res.end();
        }));
        app.get('/query', function (req, res) {
            let code = JSON.stringify(queries_1.defaultQuery, null, 2);
            res.render('explorer', {
                name: 'BMAP',
                code: code,
            });
        });
        app.get(/^\/query\/(.+)$/, function (req, res) {
            let b64 = req.params[0];
            let code = Buffer.from(b64, 'base64').toString();
            res.render('explorer', {
                name: 'BMAP',
                code: code,
            });
        });
        app.get('/', function (req, res) {
            res.sendFile(__dirname + '/public/index.html');
        });
        if (app.get('port')) {
            app.listen(app.get('port'), app.get('host'), () => {
                console.log(chalk.magenta('PLANARIUM'), chalk.green(`listening on ${app.get('host')}:${app.get('port')}!`));
            });
        }
        else {
            app.listen(app.get('port'), () => {
                console.log(chalk.magenta('PLANARIUM'), chalk.green(`listening on port ${app.get('port')}!`));
            });
        }
    });
};
start();
//# sourceMappingURL=planarium.js.map