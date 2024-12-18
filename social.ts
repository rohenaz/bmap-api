import type { Elysia } from 'elysia';
import { getDbo } from './db.js';
import { readFromRedis, saveToRedis } from './cache.js';
import { getBAPIdByAddress } from './bap.js';
import type { BapIdentity } from './bap.js';
import type { CacheSigner, CacheValue } from './cache.js';

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
  identity?: any;
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

interface ReactionResponse {
  channel: string;
  page: number;
  limit: number;
  count: number;
  results: any[];
}

type CacheReactions = {
  type: 'reactions';
  value: ReactionResponse;
}

interface ChannelInfo {
  channel: string;
  creator: string;
  last_message: string;
  last_message_time: number;
  messages: number;
}

type CacheChannels = {
  type: 'channels';
  value: ChannelInfo[];
}

function sigmaIdentityToBapIdentity(result: SigmaIdentityResult): BapIdentity {
  return {
    idKey: result.idKey,
    rootAddress: result.rootAddress,
    currentAddress: result.currentAddress,
    addresses: result.addresses,
    identity: result.identity || "",
    identityTxId: result.addresses[0]?.txId || "", // fallback if not present
    block: result.block || 0,
    timestamp: result.timestamp || 0,
    valid: result.valid ?? true
    // Removed firstSeen because it's not part of BapIdentity
  };
}

async function fetchBapIdentityData(bapId: string): Promise<BapIdentity> {
  const cacheKey = `sigmaIdentity-${bapId}`;
  const cached = await readFromRedis<CacheSigner>(cacheKey);
  if (cached.type !== 'error') {
    return cached.value as BapIdentity;
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

  // Use CacheSigner as the generic type parameter
  await saveToRedis<CacheSigner>(cacheKey, {
    type: 'signer',
    value: bapIdentity
  });

  return bapIdentity;
}

async function fetchAllFriendsAndUnfriends(bapId: string) {
  const dbo = await getDbo();

  const idData = await fetchBapIdentityData(bapId);
  if (!idData || !idData.addresses) {
    throw new Error(`No identity found for ${bapId}`);
  }

  const ownedAddresses = new Set<string>(idData.addresses.map(a => a.address));

  const incomingFriends = await dbo.collection('friend')
    .find({ "MAP.type": "friend", "MAP.bapID": bapId })
    .toArray();

  const incomingUnfriends = await dbo.collection('unfriend')
    .find({ "MAP.type": "unfriend", "MAP.bapID": bapId })
    .toArray();

  const outgoingFriends = await dbo.collection('friend')
    .find({
      "MAP.type": "friend",
      "AIP.algorithm_signing_component": { $in: [...ownedAddresses] }
    })
    .toArray();

  const outgoingUnfriends = await dbo.collection('unfriend')
    .find({
      "MAP.type": "unfriend",
      "AIP.algorithm_signing_component": { $in: [...ownedAddresses] }
    })
    .toArray();

  const allDocs = [...incomingFriends, ...incomingUnfriends, ...outgoingFriends, ...outgoingUnfriends];
  allDocs.sort((a, b) => ((a.blk?.i ?? 0) - (b.blk?.i ?? 0)));

  return { allDocs, ownedAddresses };
}

async function processRelationships(bapId: string, docs: any[], ownedAddresses: Set<string>): Promise<FriendshipResponse> {
  const relationships: Record<string, RelationshipState> = {};

  async function getRequestorBapId(doc: any): Promise<string | null> {
    const address = doc?.AIP?.[0]?.algorithm_signing_component;
    if (!address) return null;

    if (ownedAddresses.has(address)) {
      return bapId;
    } else {
      const otherIdentity = await getBAPIdByAddress(address);
      if (!otherIdentity) return null;
      return otherIdentity.idKey;
    }
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
      const channel = query.channel as string;
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

      const page = query.page ? parseInt(query.page as string, 10) : 1;
      const limit = query.limit ? parseInt(query.limit as string, 10) : 100;
      
      if (isNaN(page) || page < 1) {
        return new Response(JSON.stringify({
          error: "Invalid page parameter",
          details: "Page must be a positive integer"
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (isNaN(limit) || limit < 1 || limit > 1000) {
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
      const cached = await readFromRedis<CacheReactions>(cacheKey);

      if (cached.type === 'reactions') {
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
      await saveToRedis<CacheReactions>(cacheKey, {
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
      const cached = await readFromRedis<CacheChannels>(cacheKey);
  
      if (cached?.type === 'channels') {
        console.log('Cache hit for channels');
        // Wrap cached.value in an object { message: cached.value }
        return new Response(JSON.stringify({ message: cached.value }), {
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
          $sort: { "blk.t": 1 }
        },
        {
          $group: {
            _id: { $arrayElemAt: ["$MAP.channel", 0] },
            channel: { $arrayElemAt: ["$MAP.channel", 0] },
            creator: { $arrayElemAt: ["$MAP.paymail", 0] },
            last_message: { $arrayElemAt: ["$B.Data.utf8", 0] },
            last_message_time: { $last: "$blk.t" },
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
      await saveToRedis<CacheChannels>(cacheKey, {
        type: 'channels',
        value: typedResults
      });
  
      // Return the object with "message" key
      return new Response(JSON.stringify({ message: typedResults }), {
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
}