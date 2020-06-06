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
exports.crawler = exports.synced = exports.setCurrentBlock = void 0;
const actions_1 = require("./actions");
const chalk = require("chalk");
const config_1 = require("./config");
const es = require("event-stream");
const node_fetch_1 = require("node-fetch");
const queries_1 = require("./queries");
const bitfs_1 = require("./bitfs");
let currentBlock = 0;
let synced = false;
exports.synced = synced;
const crawl = (query, height) => {
    return new Promise((resolve, reject) => __awaiter(void 0, void 0, void 0, function* () {
        // only block indexes greater than given height
        query.q.find['blk.i'] = { $gt: height };
        let res;
        try {
            res = yield node_fetch_1.default('https://bob.bitbus.network/block', {
                method: 'post',
                headers: {
                    'Content-type': 'application/json; charset=utf-8',
                    token: config_1.config.token,
                },
                body: JSON.stringify(query),
            });
        }
        catch (e) {
            console.error('Failed to reach bitbus', e);
            reject();
            return;
        }
        // The promise is resolved when the stream ends.
        res.body
            .on('end', () => {
            resolve();
        })
            // Split NDJSON into an array stream
            .pipe(es.split())
            // Apply the logic for each line
            .pipe(es.mapSync((t) => __awaiter(void 0, void 0, void 0, function* () {
            if (t) {
                let j;
                try {
                    j = JSON.parse(t);
                }
                catch (e) {
                    // Invalid response
                    console.error('Invalid response', e, t);
                    return null;
                }
                if (!j) {
                    console.log('Invalid response', j);
                    return;
                }
                // New block
                if (j.blk && j.blk.i > currentBlock) {
                    setCurrentBlock(j.blk.i);
                    console.log(chalk.blue('####  '), chalk.magenta('NEW BLOCK '), chalk.green(currentBlock));
                    // planarium.send('socket', { type: 'block', block: currentBlock })
                }
                //             // Extract BitFS URIs
                //             // Iterate through all outputs and find chunks whose names start with "f"
                let bitfs = [];
                if (j.out) {
                    j.out.forEach((out) => {
                        for (let tape of out.tape) {
                            let cell = tape.cell;
                            for (let pushdata of cell) {
                                if (pushdata.hasOwnProperty('f')) {
                                    bitfs.push(pushdata.f);
                                }
                            }
                        }
                    });
                }
                // Crawl BitFS
                bitfs_1.saveFiles(bitfs);
                try {
                    return yield actions_1.saveTx(j);
                }
                catch (e) {
                    return null;
                }
            }
        })));
    }));
};
const crawler = (syncedCallback) => {
    crawl(queries_1.query, currentBlock).then(() => {
        if (!synced) {
            console.log(chalk.green('BITBUS SYNC COMPLETE'));
            exports.synced = synced = true;
            syncedCallback();
        }
        setTimeout(() => {
            crawler(syncedCallback);
        }, 10000);
    });
};
exports.crawler = crawler;
const setCurrentBlock = (num) => {
    currentBlock = num;
};
exports.setCurrentBlock = setCurrentBlock;
//# sourceMappingURL=crawler.js.map