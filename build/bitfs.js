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
exports.saveFiles = void 0;
const BetterQueue = require("better-queue");
const chalk = require("chalk");
const fs = require("fs");
const node_fetch_1 = require("node-fetch");
// ToDo - Using a queue so if the file download fails for some reason we can add it back to the queue?
const q = new BetterQueue(function (file) {
    let path = 'data/' + file + '.bitfs';
    // See if the file exists already before fetching it
    try {
        fs.access(path, fs.constants.F_OK, (err) => __awaiter(this, void 0, void 0, function* () {
            if (err) {
                // Fetch from BitFS and store to local file
                console.log(chalk.cyan('saving https://bitfs.network/' + file));
                let res = yield node_fetch_1.default('https://x.bitfs.network/' + file);
                res.body.pipe(fs.createWriteStream(path));
                return;
            }
            // file exists
            console.log(chalk.cyan('file already exists'));
        }));
    }
    catch (err) {
        console.log('error checking or writing file', err);
    }
}, { afterProcessDelay: 10 });
const saveFiles = (bitfs) => {
    for (let file of bitfs) {
        q.push(file);
    }
};
exports.saveFiles = saveFiles;
//# sourceMappingURL=bitfs.js.map