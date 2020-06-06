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
exports.getDbo = exports.closeDb = void 0;
const mongo = require("mongodb");
const MongoClient = mongo.MongoClient;
let client;
const getDbo = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        client = yield MongoClient.connect(process.env.MONGO_URL, {
            useUnifiedTopology: true,
            useNewUrlParser: true,
        });
        return client.db('bmap');
    }
    catch (e) {
        throw e;
    }
});
exports.getDbo = getDbo;
const closeDb = () => __awaiter(void 0, void 0, void 0, function* () {
    if (client) {
        client.close();
    }
});
exports.closeDb = closeDb;
//# sourceMappingURL=db.js.map