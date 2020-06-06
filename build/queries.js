"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sock = exports.defaultQuery = exports.prefixes = exports.query = void 0;
const config_1 = require("./config");
// OP_RETURN Protocol prefixes
const prefixes = {
    bitcom: '$',
    bitkey: '13SrNDkVzY5bHBRKNu5iXTQ7K7VqTh5tJC',
    bitpic: '18pAqbYqhzErT6Zk3a5dwxHtB9icv8jH2p',
    map: '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5',
    ron: '1GvFYzwtFix3qSAZhESQVTz9DeudHZNoh1',
};
exports.prefixes = prefixes;
// BitQuery
const query = {
    v: 3,
    q: {
        find: {
            $and: [
                {
                    'out.tape.cell.s': {
                        $in: [
                            prefixes.map,
                            prefixes.bitkey,
                            prefixes.bitpic,
                            prefixes.ron,
                            prefixes.bitcom,
                        ],
                    },
                },
                { 'blk.i': { $gt: config_1.config.from } },
            ],
        },
        sort: { 'blk.i': 1 },
        project: { out: 1, tx: 1, blk: 1, in: 1 },
    },
};
exports.query = query;
const sock = {
    v: 3,
    q: {
        find: {
            'out.tape.cell.s': {
                $in: [
                    prefixes.map,
                    prefixes.bitkey,
                    prefixes.bitpic,
                    prefixes.ron,
                    prefixes.bitcom,
                ],
            },
        },
    },
};
exports.sock = sock;
const defaultQuery = {
    v: 3,
    q: {
        find: {
            'blk.t': { $gt: Math.floor(new Date().getTime() / 1000 - 86400) },
        },
        limit: 10,
        project: { out: 0, in: 0 },
    },
};
exports.defaultQuery = defaultQuery;
//# sourceMappingURL=queries.js.map