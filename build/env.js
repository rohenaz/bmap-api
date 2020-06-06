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
exports.ensureEnvVars = void 0;
const chalk = require("chalk");
const prompt = require("prompt-async");
const ensureEnvVars = () => {
    return new Promise((resolve, reject) => __awaiter(void 0, void 0, void 0, function* () {
        if (!process.env.PLANARIA_TOKEN) {
            prompt.start();
            try {
                console.log(chalk.red('Enter Planaria Token:'));
                const { PLANARIA_TOKEN } = yield prompt.get(['PLANARIA_TOKEN']);
                process.env.PLANARIA_TOKEN = PLANARIA_TOKEN;
            }
            catch (e) {
                reject('failed to get token');
                return;
            }
        }
        if (!process.env.MINERVA_MONGO_URL) {
            prompt.start();
            try {
                chalk.red('Enter MongoDB connection URL: (mongodb://127.0.0.1:27017/bmap)');
                const { MONGO_URL } = yield prompt.get(['MONGO_URL']);
                process.env.MONGO_URL = MONGO_URL.length
                    ? MONGO_URL
                    : `mongodb://127.0.0.1:27017/bmap`;
            }
            catch (e) {
                reject('failed to get mongo url');
                return;
            }
        }
        resolve();
    }));
};
exports.ensureEnvVars = ensureEnvVars;
//# sourceMappingURL=env.js.map