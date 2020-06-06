var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const { sock } = require('./queries');
const Queue = require('better-queue');
const EventSource = require('eventsource');
const chalk = require('chalk');
const { saveTx } = require('./actions');
const { getDbo } = require('./db');
const storage = require('node-persist');
const storageOptions = {
    dir: 'persist',
    stringify: JSON.stringify,
    parse: JSON.parse,
    encoding: 'utf8',
    logging: false,
    ttl: false,
    expiredInterval: 2 * 60 * 1000,
    // in some cases, you (or some other service) might add non-valid storage files to your
    // storage dir, i.e. Google Drive, make this true if you'd like to ignore these files and not throw an error
    forgiveParseErrors: false,
};
let socket;
exports.lastEventId = () => __awaiter(this, void 0, void 0, function* () {
    return yield storage.getItem('lastEventId');
});
const close = function () {
    return __awaiter(this, void 0, void 0, function* () {
        if (socket) {
            socket.close();
        }
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
        socket = null;
        latestTxMatch = null;
        try {
            var leid = yield storage.getItem('lastEventId');
            yield storage.removeItem('lastEventId');
        }
        catch (e) {
            console.error('Failed to update event id', e);
        }
        return leid;
    });
};
const connect = function (leid) {
    return __awaiter(this, void 0, void 0, function* () {
        const b64 = Buffer.from(JSON.stringify(sock)).toString('base64');
        var queue = new Queue((item, cb) => __awaiter(this, void 0, void 0, function* () {
            try {
                console.log('SAVING', item.tx.h);
                let dbo = yield getDbo();
                yield saveTx(item, d.type === 'block' ? 'c' : 'u', dbo);
            }
            catch (e) {
                console.error('Failed to save tx. Record may already exists.', e);
            }
            cb();
        }), {});
        var url = 'https://bob.bitsocket.network/s/';
        function reopenSocket() {
            return __awaiter(this, void 0, void 0, function* () {
                socket.close();
                openSocket(yield storage.getItem('lastEventId'));
            });
        }
        function openSocket(leid) {
            if (leid) {
                socket = new EventSource(url + b64, {
                    headers: { 'Last-Event-Id': leid },
                });
            }
            else {
                socket = new EventSource(url + b64);
            }
            socket.onmessage = (e) => __awaiter(this, void 0, void 0, function* () {
                if (e.lastEventId && e.lastEventId !== 'undefined') {
                    try {
                        yield storage.setItem('lastEventId', e.lastEventId);
                    }
                    catch (e) {
                        console.error('Failed to save last event ID to persistent storage', e);
                    }
                }
                d = JSON.parse(e.data);
                if (d.type != 'open') {
                    d.data.forEach((tx) => __awaiter(this, void 0, void 0, function* () {
                        if (tx.tx.h !== (yield storage.getItem('lastSeenTx'))) {
                            queue.push(tx);
                            storage.setItem('lastSeenTx', tx.tx.h);
                        }
                        else {
                            console.log('why would this even happen?', tx.tx.h);
                        }
                    }));
                }
                else {
                    console.log(chalk.green('bitsocket opened'), 'to', chalk.cyan(url));
                }
            });
        }
        openSocket(leid);
        interval = setInterval(() => __awaiter(this, void 0, void 0, function* () {
            yield reopenSocket();
        }), 900000);
    });
};
process.on('message', (m) => __awaiter(this, void 0, void 0, function* () {
    console.log('message received!', m);
    if (m.connect) {
        try {
            yield storage.init(storageOptions);
            let lastId = yield storage.getItem('lastEventId');
            connect(lastId || null);
        }
        catch (e) {
            console.error('Failed to intialize persistent storage.', e);
        }
    }
}));
exports.connect = connect;
exports.close = close;
//# sourceMappingURL=socket.js.map