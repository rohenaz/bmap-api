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
exports.clearUnconfirmed = exports.saveTx = void 0;
const bmapjs_1 = require("bmapjs");
const chalk = require("chalk");
const db_1 = require("./db");
const saveTx = (tx) => __awaiter(void 0, void 0, void 0, function* () {
    let t;
    // Transform
    try {
        let dbo = yield db_1.getDbo();
        t = yield bmapjs_1.TransformTx(tx);
        if (t) {
            let collection = t.blk ? 'c' : 'u';
            yield dbo.collection(collection).insertOne(t);
            console.log(collection === 'u'
                ? (chalk.green('saved'), chalk.magenta('unconfirmed'))
                : '', (chalk.cyan('saved'), chalk.green(t.tx.h)));
            yield db_1.closeDb();
            return t;
        }
        else {
            yield db_1.closeDb();
            throw new Error('Invalid tx');
        }
    }
    catch (e) {
        yield db_1.closeDb();
        let txid = tx && tx.tx ? tx.tx.h : undefined;
        throw new Error('Failed to save ' + txid + ' : ' + e);
    }
});
exports.saveTx = saveTx;
const clearUnconfirmed = () => {
    return new Promise((res, rej) => __awaiter(void 0, void 0, void 0, function* () {
        let dbo = yield db_1.getDbo();
        dbo
            .listCollections({ name: 'u' })
            .toArray(function (err, collections) {
            return __awaiter(this, void 0, void 0, function* () {
                if (collections
                    .map((c) => {
                    return c.name;
                })
                    .indexOf('u') !== -1) {
                    try {
                        // ToDo - This can throw errors during sync
                        yield dbo.collection('u').drop(function (err, delOK) {
                            if (err) {
                                db_1.closeDb();
                                rej(err);
                                return;
                            }
                            if (delOK)
                                res();
                        });
                        db_1.closeDb();
                        res();
                    }
                    catch (e) {
                        db_1.closeDb();
                        rej(e);
                    }
                }
            });
        });
    }));
};
exports.clearUnconfirmed = clearUnconfirmed;
//# sourceMappingURL=actions.js.map