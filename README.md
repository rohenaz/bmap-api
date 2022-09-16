# bmap-planaria

A [Planaria](https://github.com/interplanaria) for building 'BMAP' Bitcoin apps. It uses bitbus 2.0 to crawl for transactions and transforms them with bmapjs. It runs two processes:

## Planaria

A crawler and indexer that saves transaction data into a MongoDB database.

## Planarium

A 'Planarium' (REST API) supporting BitQuery syntax.

![alt text](public/screen.png "Screenshot")

```json
{
  "find": {
    "MAP.app": "tonicpow"
  }
}
```

It then provides support for a number of known OP_RETURN protocols making queries nicer:

```json
{
  "find": {
    "BITPIC.paymail": "satchmo@moneybutton.com"
  }
}
```

For a full list of what protocols are supported see [bmapjs.com](https://bmapjs.com)

It also makes working with the results from your frontend much friendlier

```js
let res = await fetch("https://b.map.sv/q/...");
let j = res.json();
console.log("Got tx", j.tx.h, "app:", j.MAP.app);
```

# Install

### Prerequisites

Docker & Docker-Compose

### Run Locally

Install dependencies

```bash
yarn
```

Start the app (make sure your env vars are set first)

```bash
yarn start
```

### Run in docker

Build the image

```bash
docker build -t bmap-planaria .
```

Start the app
`bash
docker-compose up

````

### Configuration

`config.js` hold config values.

Set the `from` value to the block to begin indexing.

#### Install MongoDB

To run locally you will need mongodb installed.

See their [installation guide](https://docs.mongodb.com/manual/installation)

# Config

Set the following environmental variables:

- `MONGO_URL` A connection string to your mongo database. ex: mongodb://localhost:27017/bmap when running locally, or mongodb://mongo:27017/bmap from within a container.

# Run

```bash
node index
````

# More Examples

[MAP.app = TonicPow](https://b.map.sv/query/ewogICJ2IjogMywKICAicSI6IHsKICAgICJmaW5kIjogewogICAgICAiTUFQLmFwcCI6ICJ0b25pY3BvdyIKICAgIH0sCiAgICAic29ydCI6IHsgImJsay5pIjogLTEgfSwKICAgICJsaW1pdCI6IDEwCiAgfQp9)

[BITPIC.paymail = satchmo@moneybutton.com](https://b.map.sv/query/ewogICJ2IjogMywKICAicSI6IHsKICAgICJmaW5kIjogewogICAgICAiQklUUElDLnBheW1haWwiOiAic2F0Y2htb0Btb25leWJ1dHRvbi5jb20iCiAgICB9LAogICAgImxpbWl0IjogMTAKICB9Cn0=)

[BITKEY.paymail = satchmo@moneybutton.com](https://b.map.sv/query/ewogICJ2IjogMywKICAicSI6IHsKICAgICJmaW5kIjogewogICAgICAiQklUS0VZLnBheW1haWwiOiAic2F0Y2htb0Btb25leWJ1dHRvbi5jb20iCiAgICB9LAogICAgImxpbWl0IjogMTAKICB9Cn0=)

With BitQuery you can search in all sorts of ways.

#### Records within the last 24 hours:

1. Set a timestamp in the expected format.

```js
let timestamp = Math.floor(new Date().getTime() / 1000 - 86400);
```

2. Search for records since that timestamp:

```json
{
  "v": 3,
  "q": {
    "blk.t": { "$gt": <timestamp> }
  }
}
```

# BMAPjs

This Planaria returns data in BMAP format which is a derivative of [BOB](https://github.com/interplanaria/bpu):
[BMAPjs](https://github.com/rohenaz/bmap)

[bmapjs.com](https://bmapjs.com)
