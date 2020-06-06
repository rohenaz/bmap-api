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
exports.getCurrentBlock = void 0;
const db_1 = require("./db");
const getCurrentBlock = () => {
    return new Promise((resolve, reject) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            let dbo = yield db_1.getDbo();
            dbo
                .collection('c')
                .find()
                .sort({ 'blk.i': -1 })
                .limit(1)
                .toArray(function (err, result) {
                return __awaiter(this, void 0, void 0, function* () {
                    if (err) {
                        yield db_1.closeDb();
                        reject(err);
                    }
                    if (result && result.length > 0) {
                        // only clear unconfirmed when block is higher than last item from socket too latest_block
                        resolve(result[0].blk.i);
                    }
                    else {
                        console.log('No existing records. Crawling from the beginning.');
                        yield db_1.closeDb();
                        resolve(0);
                    }
                });
            });
        }
        catch (e) {
            yield db_1.closeDb();
            reject(e);
        }
    }));
};
exports.getCurrentBlock = getCurrentBlock;
//# sourceMappingURL=state.js.map