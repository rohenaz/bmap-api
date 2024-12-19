import type { Elysia } from 'elysia';
import { getDbo } from './db.js';
import { readFromRedis, saveToRedis, client } from './cache.js';
import { getBAPIdByAddress } from './bap.js';
import type { BapIdentity, BapIdentityObject } from './bap.js';
import type { CacheValue, CacheSigner } from './cache.js';
import type { WithId, Document } from 'mongodb';
import type { BmapTx } from 'bmapjs';

interface SigmaIdentityAPIResponse {
  status: string;
  result?: SigmaIdentityResult;
  error?: string;
}

interface SigmaIdentityResult {
  idKey: string;
  rootAddress: string;
  currentAddress: string;
  addresses: {
    address: string;
    txId: string;
    block?: number;
  }[];
  identity?: Record<string, unknown>;
  block?: number;
  timestamp?: number;
  valid?: boolean;
}

interface RelationshipState {
  fromMe: boolean;
  fromThem: boolean;
  unfriended: boolean;
}

interface FriendshipResponse {
  friends: string[];
  incoming: string[];
  outgoing: string[];
}

export interface ReactionResponse {
  channel: string;
  page: number;
  limit: number;
  count: number;
  results: Record<string, unknown>[];
}

export interface ChannelInfo {
  channel: string;
  creator: string;
  last_message: string;
  last_message_time: number;
  messages: number;
}

export interface MessageResponse {
  channel: string;
  page: number;
  limit: number;
  count: number;
  results: Message[];
}

interface Message {
  tx: {
    h: string;
  };
  blk: {
    i: number;
    t: number;
  };
  MAP: {
    app: string;
    type: string;
    channel: string;
    paymail: string;
  }[];
  B: {
    Data: {
      utf8: string;
    };
  }[];
  AIP?: {
    address: string;
    algorithm_signing_component: string;
  }[];
}

interface LikeRequest {
  txids?: string[];
  messageIds?: string[];
}

interface LikeDocument {
  tx: {
    h: string;
  };
  blk: {
    i: number;
    t: number;
  };
  MAP: {
    type: string;
    tx?: string;
    messageID?: string;
  }[];
  AIP?: {
    algorithm_signing_component: string;
  }[];
}

export interface LikeInfo {
  txid: string;
  likes: LikeDocument[];
  total: number;
  signerIds: string[];  // Store only signer IDs
}

interface LikeResponse {
  txid: string;
  likes: LikeDocument[];
  total: number;
  signers: BapIdentity[];  // Full signer objects for API response
}

function sigmaIdentityToBapIdentity(result: SigmaIdentityResult): BapIdentity {
  const identity = result.identity || "";
  return {
    idKey: result.idKey,
    rootAddress: result.rootAddress,
    currentAddress: result.currentAddress,
    addresses: result.addresses,
    identity: typeof identity === 'string' ? identity : JSON.stringify(identity),
    identityTxId: result.addresses[0]?.txId || "", // fallback if not present
    block: result.block || 0,
    timestamp: result.timestamp || 0,
    valid: result.valid ?? true
  };
}

async function fetchBapIdentityData(bapId: string): Promise<BapIdentity> {
  const cacheKey = `sigmaIdentity-${bapId}`;
  const cached = await readFromRedis<CacheValue>(cacheKey);
  if (cached?.type === 'signer') {
    return cached.value;
  }

  const url = 'https://api.sigmaidentity.com/v1/identity/get';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idKey: bapId })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch identity data. Status: ${resp.status}, Body: ${text}`);
  }

  const data: SigmaIdentityAPIResponse = await resp.json();
  if (data.status !== 'OK' || !data.result) {
    throw new Error(`Sigma Identity returned invalid data for ${bapId}`);
  }

  const bapIdentity = sigmaIdentityToBapIdentity(data.result);

  await saveToRedis<CacheValue>(cacheKey, {
    type: 'signer',
    value: bapIdentity
  });

  return bapIdentity;
}

async function fetchAllFriendsAndUnfriends(bapId: string): Promise<{ allDocs: BmapTx[], ownedAddresses: Set<string> }> {
  const dbo = await getDbo();

  const idData = await fetchBapIdentityData(bapId);
  if (!idData || !idData.addresses) {
    throw new Error(`No identity found for ${bapId}`);
  }

  const ownedAddresses = new Set<string>(idData.addresses.map(a => a.address));

  const incomingFriends = await dbo.collection('friend')
    .find({ "MAP.type": "friend", "MAP.bapID": bapId })
    .toArray() as unknown as BmapTx[];

  const incomingUnfriends = await dbo.collection('unfriend')
    .find({ "MAP.type": "unfriend", "MAP.bapID": bapId })
    .toArray() as unknown as BmapTx[];

  const outgoingFriends = await dbo.collection('friend')
    .find({
      "MAP.type": "friend",
      "AIP.algorithm_signing_component": { $in: [...ownedAddresses] }
    })
    .toArray() as unknown as BmapTx[];

  const outgoingUnfriends = await dbo.collection('unfriend')
    .find({
      "MAP.type": "unfriend",
      "AIP.algorithm_signing_component": { $in: [...ownedAddresses] }
    })
    .toArray() as unknown as BmapTx[];

  const allDocs = [...incomingFriends, ...incomingUnfriends, ...outgoingFriends, ...outgoingUnfriends];
  allDocs.sort((a, b) => ((a.blk?.i ?? 0) - (b.blk?.i ?? 0)));

  return { allDocs, ownedAddresses };
}

async function processRelationships(bapId: string, docs: BmapTx[], ownedAddresses: Set<string>): Promise<FriendshipResponse> {
  const relationships: Record<string, RelationshipState> = {};

  async function getRequestorBapId(doc: BmapTx): Promise<string | null> {
    const address = doc?.AIP?.[0]?.algorithm_signing_component;
    if (!address) return null;

    if (ownedAddresses.has(address)) {
      return bapId;
    }
    const otherIdentity = await getBAPIdByAddress(address);
    if (!otherIdentity) return null;
    return otherIdentity.idKey;
  }

  const requestors = await Promise.all(docs.map(doc => getRequestorBapId(doc)));

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const reqBap = requestors[i];
    const tgtBap = doc?.MAP?.[0]?.bapID;

    if (!reqBap || !tgtBap) continue;

    const otherBapId = (reqBap === bapId) ? tgtBap : reqBap;
    if (!relationships[otherBapId]) {
      relationships[otherBapId] = { fromMe: false, fromThem: false, unfriended: false };
    }

    const rel = relationships[otherBapId];
    const isFriend = doc?.MAP?.[0]?.type === 'friend';
    const isUnfriend = doc?.MAP?.[0]?.type === 'unfriend';
    const isFromMe = (reqBap === bapId);

    if (isUnfriend) {
      rel.unfriended = true;
      rel.fromMe = false;
      rel.fromThem = false;
    } else if (isFriend) {
      if (rel.unfriended) {
        rel.unfriended = false;
      }
      if (isFromMe) {
        rel.fromMe = true;
      } else {
        rel.fromThem = true;
      }
    }
  }

  const friends: string[] = [];
  const incoming: string[] = [];
  const outgoing: string[] = [];

  for (const [other, rel] of Object.entries(relationships)) {
    if (rel.unfriended) {
      continue;
    }
    if (rel.fromMe && rel.fromThem) {
      friends.push(other);
    } else if (rel.fromMe && !rel.fromThem) {
      outgoing.push(other);
    } else if (!rel.fromMe && rel.fromThem) {
      incoming.push(other);
    }
  }

  return { friends, incoming, outgoing };
}

export function registerSocialRoutes(app: Elysia) {
  app.get("/friendships/:bapId", async ({ params }) => {
    const { bapId } = params;

    if (!bapId || typeof bapId !== 'string') {
      return new Response(JSON.stringify({
        error: "Missing or invalid bapId",
        details: "The bapId parameter must be a valid string"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    }

    try {
      const { allDocs, ownedAddresses } = await fetchAllFriendsAndUnfriends(bapId);
      const result = await processRelationships(bapId, allDocs, ownedAddresses);
      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60"
        }
      });
    } catch (error: unknown) {
      console.error('Error processing friendships request:', error);
      const message = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        error: "Failed to fetch friendship data",
        details: message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    }
  });

  app.get("/reactions", async ({ query }) => {
    try {
      const channel = query.channel;
      if (!channel) {
        return new Response(JSON.stringify({
          error: "Missing 'channel' parameter",
          details: "The channel parameter is required for fetching reactions"
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          }
        });
      }

      const page = query.page ? Number.parseInt(query.page as string, 10) : 1;
      const limit = query.limit ? Number.parseInt(query.limit as string, 10) : 100;

      if (Number.isNaN(page) || page < 1) {
        return new Response(JSON.stringify({
          error: "Invalid page parameter",
          details: "Page must be a positive integer"
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
        return new Response(JSON.stringify({
          error: "Invalid limit parameter",
          details: "Limit must be between 1 and 1000"
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const skip = (page - 1) * limit;

      const cacheKey = `reactions:${channel}:${page}:${limit}`;
      const cached = await readFromRedis<CacheValue>(cacheKey);

      if (cached?.type === 'reactions') {
        console.log('Cache hit for reactions:', cacheKey);
        return new Response(JSON.stringify(cached.value), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60"
          }
        });
      }

      console.log('Cache miss for reactions:', cacheKey);
      const db = await getDbo();

      const queryObj = {
        "MAP.type": "like",
        "MAP.channel": channel
      };

      const col = db.collection("like");

      // Get total count first
      const count = await col.countDocuments(queryObj);

      // Then get paginated results
      const results = await col
        .find(queryObj)
        .sort({ "blk.i": -1 })
        .skip(skip)
        .limit(limit)
        .project({ _id: 0 })  // Exclude _id field
        .toArray();

      const response: ReactionResponse = {
        channel,
        page,
        limit,
        count,
        results
      };

      // Cache for 60 seconds
      await saveToRedis<CacheValue>(cacheKey, {
        type: 'reactions',
        value: response
      });

      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60"
        }
      });
    } catch (error: unknown) {
      console.error('Error processing reactions request:', error);
      const message = error instanceof Error ? error.message : String(error);

      // Log additional error details if available
      if (error instanceof Error && error.stack) {
        console.error('Error stack:', error.stack);
      }

      return new Response(JSON.stringify({
        error: "Failed to fetch reactions",
        details: message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    }
  });
  app.get("/channels", async () => {
    try {
      const cacheKey = 'channels';
      const cached = await readFromRedis<CacheValue>(cacheKey);

      if (cached?.type === 'channels') {
        console.log('Cache hit for channels');
        return new Response(JSON.stringify({ channels: cached.value }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60"
          }
        });
      }

      console.log('Cache miss for channels');
      const db = await getDbo();

      const pipeline = [
        {
          $match: {
            "MAP.channel": { $exists: true, $ne: "" }
          }
        },
        {
          $unwind: "$MAP"
        },
        {
          $unwind: "$B"
        },
        {
          $group: {
            _id: "$MAP.channel",
            channel: { $first: "$MAP.channel" },
            creator: { $first: "$MAP.paymail" },
            last_message: { $last: "$B.Data.utf8" },
            last_message_time: { $max: "$blk.t" },
            messages: { $sum: 1 }
          }
        },
        {
          $sort: { last_message_time: -1 }
        },
        {
          $limit: 100
        }
      ];

      const results = await db.collection("message").aggregate(pipeline).toArray();

      // Cast the results to ChannelInfo[]
      const typedResults = results as unknown as ChannelInfo[];

      // Cache for 60 seconds
      await saveToRedis<CacheValue>(cacheKey, {
        type: 'channels',
        value: typedResults
      });

      // Return the object with "channels" key instead of "message"
      return new Response(JSON.stringify({ channels: typedResults }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60"
        }
      });
    } catch (error: unknown) {
      console.error('Error processing channels request:', error);
      const message = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        error: "Failed to fetch channels",
        details: message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    }
  });

  app.get("/messages/:channelId", async ({ params, query }) => {
    try {
      const { channelId } = params;
      if (!channelId) {
        return new Response(JSON.stringify({
          error: "Missing channel ID",
          details: "The channel ID is required in the URL path"
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          }
        });
      }

      // Decode the channel ID from the URL
      const decodedChannelId = decodeURIComponent(channelId);

      const page = query.page ? Number.parseInt(query.page, 10) : 1;
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 100;

      if (Number.isNaN(page) || page < 1) {
        return new Response(JSON.stringify({
          error: "Invalid page parameter",
          details: "Page must be a positive integer"
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
        return new Response(JSON.stringify({
          error: "Invalid limit parameter",
          details: "Limit must be between 1 and 1000"
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const skip = (page - 1) * limit;

      // Use the decoded channel ID for cache key
      const cacheKey = `messages:${decodedChannelId}:${page}:${limit}`;
      const cached = await readFromRedis<CacheValue>(cacheKey);

      if (cached?.type === 'messages') {
        console.log('Cache hit for messages:', cacheKey);
        return new Response(JSON.stringify(cached.value), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60"
          }
        });
      }

      console.log('Cache miss for messages:', cacheKey);
      const db = await getDbo();

      const queryObj = {
        "MAP.type": "message",
        "MAP.channel": decodedChannelId
      };

      const col = db.collection("message");

      // Get total count first
      const count = await col.countDocuments(queryObj);

      // Then get paginated results
      const results = await col
        .find(queryObj)
        .sort({ "blk.t": -1 })
        .skip(skip)
        .limit(limit)
        .project({ _id: 0 })  // Exclude _id field
        .toArray() as Message[];

      const response: MessageResponse = {
        channel: decodedChannelId,
        page,
        limit,
        count,
        results
      };

      // Cache for 60 seconds
      await saveToRedis<CacheValue>(cacheKey, {
        type: 'messages',
        value: response
      });

      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60"
        }
      });
    } catch (error: unknown) {
      console.error('Error processing messages request:', error);
      const message = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        error: "Failed to fetch messages",
        details: message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    }
  });

  app.post("/likes", async ({ body, query }) => {
    try {
      // Handle both array and object formats, and support both txids and messageIds
      let txids: string[] = [];
      let messageIds: string[] = [];
      
      if (Array.isArray(body)) {
        txids = body;
      } else {
        const request = body as LikeRequest;
        txids = request.txids || [];
        messageIds = request.messageIds || [];
      }

      // Support the old query format if present
      if (query?.d === 'disc-react' && messageIds.length === 0) {
        messageIds = txids;
        txids = [];
      }
      
      if (txids.length === 0 && messageIds.length === 0) {
        return new Response(JSON.stringify({
          error: "Invalid request",
          details: "Request must include either txids or messageIds"
        }), {
          status: 400,
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      }

      const db = await getDbo();
      const results: LikeResponse[] = [];

      // Process txids
      for (const txid of txids) {
        // Check cache first
        const cacheKey = `likes:${txid}`;
        const cached = await readFromRedis<CacheValue>(cacheKey);

        if (cached?.type === 'likes' && cached.value) {
          // Convert cached info to response format
          const signers = await Promise.all(
            cached.value.signerIds.map(id => getBAPIdByAddress(id))
          );
          results.push({
            txid: cached.value.txid,
            likes: cached.value.likes,
            total: cached.value.total,
            signers: signers.filter((s): s is BapIdentity => s !== null)
          });
          continue;
        }

        // Query MongoDB for likes
        const query = {
          "MAP": {
            $elemMatch: {
              type: "like",
              tx: txid
            }
          }
        };
        
        console.log('Querying MongoDB for likes with:', JSON.stringify(query, null, 2));
        
        const likes = await db.collection("like")
          .find(query)
          .sort({ "blk.t": -1 })
          .limit(1000)
          .toArray() as unknown as LikeDocument[];

        console.log(`Found ${likes.length} likes for txid ${txid}`);

        // Process likes and get signers
        const { signerIds, signers } = await processLikes(likes);

        // Cache minimal info
        const likeInfo: LikeInfo = {
          txid,
          likes,
          total: likes.length,
          signerIds
        };

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'likes',
          value: likeInfo
        });

        // Add full response with signer objects
        results.push({
          txid: likeInfo.txid,
          likes: likeInfo.likes,
          total: likeInfo.total,
          signers
        });
      }

      // Process messageIds
      for (const messageId of messageIds) {
        // Check cache first
        const cacheKey = `likes:msg:${messageId}`;
        const cached = await readFromRedis<CacheValue>(cacheKey);

        if (cached?.type === 'likes' && cached.value) {
          // Convert cached info to response format
          const signers = await Promise.all(
            cached.value.signerIds.map(id => getBAPIdByAddress(id))
          );
          results.push({
            txid: messageId,
            likes: cached.value.likes,
            total: cached.value.total,
            signers: signers.filter((s): s is BapIdentity => s !== null)
          });
          continue;
        }

        // Query MongoDB for likes
        const query = {
          "MAP": {
            $elemMatch: {
              type: "like",
              messageID: messageId
            }
          }
        };
        
        console.log('Querying MongoDB for likes with messageID:', JSON.stringify(query, null, 2));
        
        const likes = await db.collection("like")
          .find(query)
          .sort({ "blk.t": -1 })
          .limit(1000)
          .toArray() as unknown as LikeDocument[];

        console.log(`Found ${likes.length} likes for messageID ${messageId}`);

        // Process likes and get signers
        const { signerIds, signers } = await processLikes(likes);

        // Cache minimal info
        const likeInfo: LikeInfo = {
          txid: messageId,
          likes,
          total: likes.length,
          signerIds
        };

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'likes',
          value: likeInfo
        });

        // Add full response with signer objects
        results.push({
          txid: likeInfo.txid,
          likes: likeInfo.likes,
          total: likeInfo.total,
          signers
        });
      }

      // Return just the first result since we want a single object response
      return new Response(JSON.stringify(results[0]), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });

    } catch (error: unknown) {
      console.error('Error processing likes request:', error);
      const message = error instanceof Error ? error.message : String(error);

      return new Response(JSON.stringify({
        error: "Failed to fetch likes",
        details: message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
  });

  // Helper function to process likes and get signers
  async function processLikes(likes: LikeDocument[]): Promise<{ signerIds: string[]; signers: BapIdentity[] }> {
    // Get unique signer addresses
    const signerAddresses = new Set<string>();
    for (const like of likes) {
      if (Array.isArray(like.AIP)) {
        for (const aip of like.AIP) {
          if (aip.algorithm_signing_component) {
            signerAddresses.add(aip.algorithm_signing_component);
          }
        }
      }
    }

    // Fetch signer identities
    const signerIds = Array.from(signerAddresses);
    const signers = await Promise.all(
      signerIds.map(async (address) => {
        const signerCacheKey = `signer-${address}`;
        const cachedSigner = await readFromRedis<CacheValue>(signerCacheKey);
        
        if (cachedSigner?.type === 'signer' && cachedSigner.value) {
          return cachedSigner.value;
        }

        try {
          const identity = await getBAPIdByAddress(address);
          if (identity) {
            await saveToRedis<CacheValue>(signerCacheKey, {
              type: 'signer',
              value: identity
            });
            return identity;
          }
        } catch (error) {
          console.error(`Failed to fetch identity for address ${address}:`, error);
        }
        return null;
      })
    );

    return {
      signerIds,
      signers: signers.filter((s): s is BapIdentity => s !== null)
    };
  }

  // Add OPTIONS handler for CORS preflight
  app.options("/likes", () => {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  });
}