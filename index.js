const fetch = require("node-fetch");
const bmap = require("bmapjs");
const es = require("event-stream");
const mongo = require("mongodb");
const fs = require("fs");
const chalk = require("chalk");
const Queue = require("better-queue");
const prompt = require("prompt-async");
const { fork } = require("child_process");
const planarium = fork("planarium.js");
const EventSource = require("eventsource");
const { config } = require("./config");
let synced = false;

// Open up the server and send sockets to child. Use pauseOnConnect to prevent
// the sockets from being read before they are sent to the child process.
const server = require("net").createServer({ pauseOnConnect: true });
server.on("connection", (socket) => {
  planarium.send("socket", socket);
});
server.listen(1337);

const { query, sock } = require("./queries");

// ToDo - Using a queue so if the file download fails for some reason we can add it back to the queue?
let q = new Queue(
  function (file, cb) {
    let path = "data/" + file + ".bitfs";

    // See if the file exists already before fetching it
    try {
      fs.access(path, fs.F_OK, async (err) => {
        if (err) {
          // Fetch from BitFS and store to local file
          console.log(chalk.cyan("saving https://bitfs.network/" + file));
          let res = await fetch("https://x.bitfs.network/" + file);
          res.body.pipe(fs.createWriteStream(path));
          return;
        }
        // file exists
        console.log(chalk.cyan("file already exists"));
      });
    } catch (err) {
      console.log("error checking or writing file", err);
    }

    cb(null, result);
  },
  { afterProcessDelay: 10 }
);

const connect = () => {
  // Base64 encode bitquery
  const b64 = Buffer.from(JSON.stringify(sock)).toString("base64");
  // Subscribe
  let surl = "https://bob.bitsocket.network/s/";
  const s = new EventSource(surl + b64);
  s.onmessage = function (e) {
    let d = JSON.parse(e.data);
    switch (d.type) {
      case "open":
        console.log(chalk.green("bitsocket opened"), "to", chalk.cyan(surl));
        break;
      case "push":
        // save latest_block
        d.data.forEach(async (item) => {
          try {
            await saveTx(item, d.type === "block" ? "c" : "u");
          } catch (e) {
            // record already exists in the db
          }
        });
        break;
    }
  };
};

let current_block = 0;

let db = null;

const start = async () => {
  // Make sure we have a data directory
  if (!fs.existsSync("./data")) {
    fs.mkdirSync("./data");
  }

  if (!process.env.PLANARIA_TOKEN) {
    prompt.start();
    try {
      console.log(chalk.red("Enter Planaria Token:"));
      const { PLANARIA_TOKEN } = await prompt.get(["PLANARIA_TOKEN"]);
      process.env.PLANARIA_TOKEN = PLANARIA_TOKEN;
    } catch (e) {
      console.log("failed to get token");
    }
  }

  if (!process.env.MONGO_URL) {
    prompt.start();
    try {
      console.log(chalk.red("Enter MongoDB URL:"));
      const { MONGO_URL } = await prompt.get(["MONGO_URL"]);
      process.env.MONGO_URL = MONGO_URL;
    } catch (e) {
      console.log("failed to get mongo url");
    }
  }

  mongo.MongoClient.connect(
    process.env.MONGO_URL,
    {
      useUnifiedTopology: true,
      useNewUrlParser: true,
    },
    function (err, res) {
      if (err) throw err;

      db = res;
      let dbo = db.db("bmap");

      // Create collections
      dbo.createCollection("c", function (err, res) {
        if (err) throw err;
      });

      dbo.createCollection("u", function (err, res) {
        if (err) throw err;
      });

      dbo
        .collection("c")
        .find()
        .sort({ "blk.i": -1 })
        .limit(1)
        .toArray(async function (err, result) {
          if (err) throw err;

          if (result && result.length > 0) {
            // onle clear unconfirmed when block is higher than last item from socket too latest_block
            current_block = result[0].blk.i;
          } else {
            console.log("No existing records. Crawling from the beginning.");
          }
          console.log(chalk.cyan("crawling from", current_block));
          crawler();
        });
    }
  );
};

const saveFiles = (bitfs) => {
  for (let file of bitfs) {
    q.push(file);
  }
};

const crawl = (query, height) => {
  return new Promise(async (resolve, reject) => {
    if (!db) {
      reject();
    }
    // Create a timestamped query by applying the "$gt" (greater than) operator with the height
    query.q.find["blk.i"] = { $gt: height };

    let res = await fetch("https://bob.bitbus.network/block", {
      method: "post",
      headers: {
        "Content-type": "application/json; charset=utf-8",
        token: config.token,
      },
      body: JSON.stringify(query),
    });

    // The promise is resolved when the stream ends.
    res.body
      .on("end", () => {
        resolve();
      })
      // Split NDJSON into an array stream
      .pipe(es.split())
      // Apply the logic for each line
      .pipe(
        es.mapSync(async (t) => {
          if (t) {
            let j;
            try {
              j = JSON.parse(t);
            } catch (e) {
              // Invalid response
              console.error("Invalid response", e, t);
              return null;
            }
            if (!j) {
              console.log("oh no", j);
              return;
            }
            // New block
            if (j.blk && j.blk.i > current_block) {
              current_block = j.blk.i;
              console.log(
                chalk.blue(
                  "######################################################################"
                )
              );
              console.log(
                chalk.blue("####  "),
                chalk.magenta("NEW BLOCK "),
                chalk.green(current_block)
              );
              console.log(
                chalk.blue(
                  "######################################################################"
                )
              );
              if (synced) {
                await clearUnconfirmed();
              }
              // planarium.send('socket', {type: 'block', block: current_block})
            }

            // Extract BitFS URIs
            // Iterate through all outputs and find chunks whose names start with "f"
            let bitfs = [];
            if (j.out) {
              j.out.forEach((out) => {
                for (let tape of out.tape) {
                  let cell = tape.cell;
                  for (let pushdata of cell) {
                    if (pushdata.hasOwnProperty("f")) {
                      bitfs.push(pushdata.f);
                    }
                  }
                }
              });  
            }
                        // Crawl BitFS
            saveFiles(bitfs);

            try {
              let tx = await saveTx(j, "c");
              return tx;
            } catch (e) {
              return null;
            }
          }
        })
      );
  });
};

const clearUnconfirmed = () => {
  let dbo = db.db("bmap");
  return new Promise((res, rej) => {
    dbo
      .listCollections({ name: "u" })
      .toArray(async function (err, collections) {
        if (
          collections
            .map((c) => {
              return c.name;
            })
            .indexOf("u") !== -1
        ) {
          try {
            // await dbo.collection('u').drop(function(err, delOK) {
            //   if (err) rej(err)
            //   if (delOK) res()
            // })
            res();
          } catch (e) {
            rej(e);
          }
        }
      });
  });
};

const saveTx = async (tx, collection) => {
  let t;
  // Transform
  try {
    t = await bmap.TransformTx(tx);
  } catch (e) {
    throw new Error("Failed to transform", e, t);
  }

  let dbo = db.db("bmap");
  if (t) {
    await dbo.collection(collection).insertOne(t);
    console.log(
      collection === "u"
        ? (chalk.green("saved"), chalk.magenta("unconfirmed"))
        : "",
      (chalk.cyan("saved"), chalk.green(t.tx.h))
    );
    return t;
  } else {
    throw new Error("Invalid tx");
  }
};

const crawler = () => {
  crawl(query, current_block).then(() => {
    if (!synced) {
      console.log(chalk.green("SYNC COMPLETE"));
      synced = true;
      connect();
    }

    setTimeout(() => {
      crawler();
    }, 10000);
  });
};

// Handle interrupt
if (process.platform === "win32") {
  let rl = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("SIGINT", function () {
    process.emit("SIGINT");
  });
}

process.on("SIGINT", function () {
  // graceful shutdown
  server.close();
  db.close();
  process.exit();
});

console.log(
  chalk.yellow(`
:::::::::  ::::    ::::      :::     :::::::::  
  :+:    :+: +:+:+: :+:+:+   :+: :+:   :+:    :+: 
  +:+    +:+ +:+ +:+:+ +:+  +:+   +:+  +:+    +:+ 
  +#++:++#+  +#+  +:+  +#+ +#++:++#++: +#++:++#+  
  +#+    +#+ +#+       +#+ +#+     +#+ +#+        
  #+#    #+# #+#       #+# #+#     #+# #+#        
  #########  ###       ### ###     ### ###
`)
);

setTimeout(start, 1000);
