import { ReadableStream } from 'node:stream/web';
import type { BmapTx } from 'bmapjs';
import chalk from 'chalk';
import type { Elysia } from 'elysia';
import type { Document, WithId } from 'mongodb';
import type { ChangeStreamDocument } from 'mongodb';
import type { ChangeStream } from 'mongodb';
import { getBAPIdByAddress } from './bap.js';
import type { BapIdentity, BapIdentityObject } from './bap.js';
import { client, readFromRedis, saveToRedis } from './cache.js';
import type { CacheSigner, CacheValue } from './cache.js';
import { getDbo } from './db.js';

// Bitcoin schema collections to watch
const bitcoinSchemaCollections = [
  'follow',
  'unfollow',
  'unlike',
  'like',
  'message',
  'repost',
  'friend',
  'post',
  'ord',
];

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

export interface Reactions {
  channel: string;
  page: number;
  limit: number;
  count: number;
  results: Reaction[];
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

interface Reaction {
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
    emoji?: string;
  }[];
  AIP?: {
    algorithm_signing_component: string;
  }[];
}

export interface LikeInfo {
  txid: string;
  likes: Reaction[];
  total: number;
  signerIds: string[]; // Store only signer IDs
}

interface LikeResponse {
  txid: string;
  likes: Reaction[];
  total: number;
  signers: BapIdentity[]; // Full signer objects for API response
}

function sigmaIdentityToBapIdentity(result: SigmaIdentityResult): BapIdentity {
  const identity = result.identity || '';
  return {
    idKey: result.idKey,
    rootAddress: result.rootAddress,
    currentAddress: result.currentAddress,
    addresses: result.addresses,
    identity: typeof identity === 'string' ? identity : JSON.stringify(identity),
    identityTxId: result.addresses[0]?.txId || '', // fallback if not present
    block: result.block || 0,
    timestamp: result.timestamp || 0,
    valid: result.valid ?? true,
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
    body: JSON.stringify({ idKey: bapId }),
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
    value: bapIdentity,
  });

  return bapIdentity;
}

async function fetchAllFriendsAndUnfriends(
  bapId: string
): Promise<{ allDocs: BmapTx[]; ownedAddresses: Set<string> }> {
  const dbo = await getDbo();

  const idData = await fetchBapIdentityData(bapId);
  if (!idData || !idData.addresses) {
    throw new Error(`No identity found for ${bapId}`);
  }

  const ownedAddresses = new Set<string>(idData.addresses.map((a) => a.address));

  const incomingFriends = (await dbo
    .collection('friend')
    .find({ 'MAP.type': 'friend', 'MAP.bapID': bapId })
    .toArray()) as unknown as BmapTx[];

  const incomingUnfriends = (await dbo
    .collection('unfriend')
    .find({ 'MAP.type': 'unfriend', 'MAP.bapID': bapId })
    .toArray()) as unknown as BmapTx[];

  const outgoingFriends = (await dbo
    .collection('friend')
    .find({
      'MAP.type': 'friend',
      'AIP.algorithm_signing_component': { $in: [...ownedAddresses] },
    })
    .toArray()) as unknown as BmapTx[];

  const outgoingUnfriends = (await dbo
    .collection('unfriend')
    .find({
      'MAP.type': 'unfriend',
      'AIP.algorithm_signing_component': { $in: [...ownedAddresses] },
    })
    .toArray()) as unknown as BmapTx[];

  const allDocs = [
    ...incomingFriends,
    ...incomingUnfriends,
    ...outgoingFriends,
    ...outgoingUnfriends,
  ];
  allDocs.sort((a, b) => (a.blk?.i ?? 0) - (b.blk?.i ?? 0));

  return { allDocs, ownedAddresses };
}

async function processRelationships(
  bapId: string,
  docs: BmapTx[],
  ownedAddresses: Set<string>
): Promise<FriendshipResponse> {
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

  const requestors = await Promise.all(docs.map((doc) => getRequestorBapId(doc)));

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const reqBap = requestors[i];
    const tgtBap = doc?.MAP?.[0]?.bapID;

    if (!reqBap || !tgtBap) continue;

    const otherBapId = reqBap === bapId ? tgtBap : reqBap;
    if (!relationships[otherBapId]) {
      relationships[otherBapId] = { fromMe: false, fromThem: false, unfriended: false };
    }

    const rel = relationships[otherBapId];
    const isFriend = doc?.MAP?.[0]?.type === 'friend';
    const isUnfriend = doc?.MAP?.[0]?.type === 'unfriend';
    const isFromMe = reqBap === bapId;

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

// Common CORS headers for all endpoints
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
};

// Common response headers for success responses
const successHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=60',
  ...corsHeaders,
};

// Common response headers for error responses
const errorHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
  ...corsHeaders,
};

// Validation helper for signer data
function validateSignerData(signer: BapIdentity): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!signer.idKey) errors.push('Missing idKey');
  if (!signer.currentAddress) errors.push('Missing currentAddress');
  if (!signer.rootAddress) errors.push('Missing rootAddress');
  if (!signer.addresses || !signer.addresses.length) errors.push('Missing addresses');

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// Helper to process likes with better error handling and logging
async function processLikes(
  likes: Reaction[]
): Promise<{ signerIds: string[]; signers: BapIdentity[] }> {
  console.log('Processing likes:', likes.length);

  // Get unique signer addresses with validation
  const signerAddresses = new Set<string>();
  const invalidLikes: string[] = [];

  for (const like of likes) {
    if (!Array.isArray(like.AIP)) {
      console.warn('Invalid like document - missing AIP array:', like.tx?.h);
      invalidLikes.push(like.tx?.h);
      continue;
    }

    for (const aip of like.AIP) {
      if (!aip.algorithm_signing_component) {
        console.warn('Invalid AIP entry - missing algorithm_signing_component:', like.tx?.h);
        continue;
      }
      signerAddresses.add(aip.algorithm_signing_component);
    }
  }

  if (invalidLikes.length > 0) {
    console.warn('Found invalid like documents:', invalidLikes);
  }

  console.log('Found unique signer addresses:', signerAddresses.size);

  // Fetch and validate signer identities
  const signerIds = Array.from(signerAddresses);
  const signerResults = await Promise.all(
    signerIds.map(async (address) => {
      const signerCacheKey = `signer-${address}`;
      const cachedSigner = await readFromRedis<CacheValue>(signerCacheKey);

      if (cachedSigner?.type === 'signer' && cachedSigner.value) {
        const validation = validateSignerData(cachedSigner.value);
        if (!validation.isValid) {
          console.warn(
            'Invalid cached signer data for address:',
            address,
            'Errors:',
            validation.errors
          );
          return null;
        }
        return cachedSigner.value;
      }

      try {
        const identity = await getBAPIdByAddress(address);
        if (identity) {
          const validation = validateSignerData(identity);
          if (!validation.isValid) {
            console.warn(
              'Invalid fetched signer data for address:',
              address,
              'Errors:',
              validation.errors
            );
            return null;
          }

          await saveToRedis<CacheValue>(signerCacheKey, {
            type: 'signer',
            value: identity,
          });
          return identity;
        }
      } catch (error) {
        console.error(`Failed to fetch identity for address ${address}:`, error);
      }
      return null;
    })
  );

  const validSigners = signerResults.filter((s): s is BapIdentity => s !== null);
  console.log('Successfully processed signers:', validSigners.length);

  return {
    signerIds: validSigners.map((s) => s.idKey),
    signers: validSigners,
  };
}

export function registerSocialRoutes(app: Elysia) {
  // Add OPTIONS handler for all routes with proper headers
  app.options('*', ({ set }) => {
    set.headers = corsHeaders;
    set.status = 204;
    return null;
  });

  app.get('/friendships/:bapId', async ({ params, set }) => {
    const { bapId } = params;

    if (!bapId || typeof bapId !== 'string') {
      set.status = 400;
      set.headers = errorHeaders;
      return {
        error: 'Missing or invalid bapId',
        details: 'The bapId parameter must be a valid string',
      };
    }

    try {
      const { allDocs, ownedAddresses } = await fetchAllFriendsAndUnfriends(bapId);
      const result = await processRelationships(bapId, allDocs, ownedAddresses);
      set.headers = successHeaders;
      return result;
    } catch (error: unknown) {
      console.error('Error processing friendships request:', error);
      const message = error instanceof Error ? error.message : String(error);

      set.status = 500;
      set.headers = errorHeaders;
      return {
        error: 'Failed to fetch friendship data',
        details: message,
      };
    }
  });

  app.post('/likes', async ({ body, query, set }) => {
    set.headers = {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    };

    try {
      console.log('Received /likes request:', { body, query });

      // Handle channel-based query
      if (query.channel) {
        const page = query.page ? Number.parseInt(query.page as string, 10) : 1;
        const limit = query.limit ? Number.parseInt(query.limit as string, 10) : 100;

        if (Number.isNaN(page) || page < 1) {
          set.status = 400;
          return {
            error: 'Invalid page parameter',
            details: 'Page must be a positive integer',
          };
        }

        if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
          set.status = 400;
          return {
            error: 'Invalid limit parameter',
            details: 'Limit must be between 1 and 1000',
          };
        }

        const skip = (page - 1) * limit;
        const cacheKey = `likes:channel:${query.channel}:${page}:${limit}`;
        const cached = await readFromRedis<CacheValue>(cacheKey);

        if (cached?.type === 'reactions') {
          console.log('Cache hit for channel likes:', cacheKey);
          return cached.value;
        }

        console.log('Cache miss for channel likes:', cacheKey);
        const db = await getDbo();

        const queryObj = {
          'MAP.type': 'like',
          'MAP.channel': query.channel,
        };

        const col = db.collection('like');
        const count = await col.countDocuments(queryObj);
        const results = (await col
          .find(queryObj)
          .sort({ 'blk.i': -1 })
          .skip(skip)
          .limit(limit)
          .project({ _id: 0 })
          .toArray()) as Reaction[];

        const response: Reactions = {
          channel: query.channel,
          page,
          limit,
          count,
          results,
        };

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'reactions',
          value: response,
        });

        return response;
      }

      // Handle ID-based queries (existing functionality)
      let txids: string[] = [];
      let messageIds: string[] = [];

      if (Array.isArray(body)) {
        console.log('Request body is an array of length:', body.length);
        txids = body.filter((id) => typeof id === 'string');
        if (txids.length !== body.length) {
          console.warn('Some array items were not strings:', body);
        }
      } else if (body && typeof body === 'object') {
        console.log('Request body is an object:', body);
        const request = body as LikeRequest;
        txids = (request.txids || []).filter((id) => typeof id === 'string');
        messageIds = (request.messageIds || []).filter((id) => typeof id === 'string');
      } else {
        console.warn('Invalid request body format:', body);
        set.status = 400;
        return {
          error: 'Invalid request format',
          details: 'Request body must be an array of txids or an object with txids/messageIds',
        };
      }

      if (query?.d === 'disc-react' && messageIds.length === 0) {
        console.log('Using legacy disc-react format');
        messageIds = txids;
        txids = [];
      }

      if (txids.length === 0 && messageIds.length === 0) {
        console.log('No valid IDs provided');
        set.status = 400;
        return {
          error: 'Invalid request',
          details: 'Request must include either txids or messageIds',
        };
      }

      console.log('Processing request with:', { txids, messageIds });

      const db = await getDbo();
      const results: LikeResponse[] = [];

      // Process txids
      for (const txid of txids) {
        const cacheKey = `likes:${txid}`;
        const cached = await readFromRedis<CacheValue>(cacheKey);

        if (cached?.type === 'likes' && cached.value) {
          const signers = await Promise.all(
            cached.value.signerIds.map((id) => getBAPIdByAddress(id))
          );
          results.push({
            txid: cached.value.txid,
            likes: cached.value.likes,
            total: cached.value.total,
            signers: signers.filter((s): s is BapIdentity => s !== null),
          });
          continue;
        }

        const query = {
          MAP: {
            $elemMatch: {
              type: 'like',
              tx: txid,
            },
          },
        };

        console.log('Querying MongoDB for likes with:', JSON.stringify(query, null, 2));

        const likes = (await db
          .collection('like')
          .find(query)
          .sort({ 'blk.t': -1 })
          .limit(1000)
          .toArray()) as unknown as Reaction[];

        console.log(`Found ${likes.length} likes for txid ${txid}`);

        const { signerIds, signers } = await processLikes(likes);

        const likeInfo: LikeInfo = {
          txid,
          likes,
          total: likes.length,
          signerIds,
        };

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'likes',
          value: likeInfo,
        });

        results.push({
          txid: likeInfo.txid,
          likes: likeInfo.likes,
          total: likeInfo.total,
          signers,
        });
      }

      // Process messageIds
      for (const messageId of messageIds) {
        const cacheKey = `likes:msg:${messageId}`;
        const cached = await readFromRedis<CacheValue>(cacheKey);

        if (cached?.type === 'likes' && cached.value) {
          const signers = await Promise.all(
            cached.value.signerIds.map((id) => getBAPIdByAddress(id))
          );
          results.push({
            txid: messageId,
            likes: cached.value.likes,
            total: cached.value.total,
            signers: signers.filter((s): s is BapIdentity => s !== null),
          });
          continue;
        }

        const query = {
          MAP: {
            $elemMatch: {
              type: 'like',
              messageID: messageId,
            },
          },
        };

        console.log('Querying MongoDB for likes with messageID:', JSON.stringify(query, null, 2));

        const likes = (await db
          .collection('like')
          .find(query)
          .sort({ 'blk.t': -1 })
          .limit(1000)
          .toArray()) as unknown as Reaction[];

        console.log(`Found ${likes.length} likes for messageID ${messageId}`);

        const { signerIds, signers } = await processLikes(likes);

        const likeInfo: LikeInfo = {
          txid: messageId,
          likes,
          total: likes.length,
          signerIds,
        };

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'likes',
          value: likeInfo,
        });

        results.push({
          txid: likeInfo.txid,
          likes: likeInfo.likes,
          total: likeInfo.total,
          signers,
        });
      }

      return results[0] || { txid: '', likes: [], total: 0, signers: [] };
    } catch (error: unknown) {
      console.error('Error processing likes request:', error);
      const message = error instanceof Error ? error.message : String(error);

      set.status = 500;
      set.headers = {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      };
      return {
        error: 'Failed to fetch likes',
        details: message,
        timestamp: new Date().toISOString(),
      };
    }
  });

  app.get('/channels', async ({ set }) => {
    try {
      const cacheKey = 'channels';
      const cached = await readFromRedis<CacheValue>(cacheKey);

      if (cached?.type === 'channels') {
        console.log('Cache hit for channels');
        set.headers = {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        };
        return cached.value;
      }

      console.log('Cache miss for channels');
      const db = await getDbo();

      const pipeline = [
        {
          $match: {
            'MAP.channel': { $exists: true, $ne: '' },
          },
        },
        {
          $unwind: '$MAP',
        },
        {
          $unwind: '$B',
        },
        {
          $group: {
            _id: '$MAP.channel',
            channel: { $first: '$MAP.channel' },
            creator: { $first: '$MAP.paymail' },
            last_message: { $last: '$B.Data.utf8' },
            last_message_time: { $max: '$blk.t' },
            messages: { $sum: 1 },
          },
        },
        {
          $sort: { last_message_time: -1 },
        },
        {
          $limit: 100,
        },
      ];

      const results = await db.collection('message').aggregate(pipeline).toArray();
      const typedResults = results as unknown as ChannelInfo[];

      await saveToRedis<CacheValue>(cacheKey, {
        type: 'channels',
        value: typedResults,
      });

      set.headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      };
      return typedResults;
    } catch (error: unknown) {
      console.error('Error processing channels request:', error);
      const message = error instanceof Error ? error.message : String(error);

      set.status = 500;
      set.headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      };
      return {
        error: 'Failed to fetch channels',
        details: message,
        timestamp: new Date().toISOString(),
      };
    }
  });

  app.get('/messages/:channelId', async ({ params, query, set }) => {
    try {
      const { channelId } = params;
      if (!channelId) {
        set.status = 400;
        set.headers = {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        };
        return {
          error: 'Missing channel ID',
          details: 'The channel ID is required in the URL path',
        };
      }

      const decodedChannelId = decodeURIComponent(channelId);

      const page = query.page ? Number.parseInt(query.page, 10) : 1;
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 100;

      if (Number.isNaN(page) || page < 1) {
        set.status = 400;
        set.headers = { 'Content-Type': 'application/json' };
        return {
          error: 'Invalid page parameter',
          details: 'Page must be a positive integer',
        };
      }

      if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
        set.status = 400;
        set.headers = { 'Content-Type': 'application/json' };
        return {
          error: 'Invalid limit parameter',
          details: 'Limit must be between 1 and 1000',
        };
      }

      const skip = (page - 1) * limit;

      const cacheKey = `messages:${decodedChannelId}:${page}:${limit}`;
      const cached = await readFromRedis<CacheValue>(cacheKey);

      if (cached?.type === 'messages') {
        console.log('Cache hit for messages:', cacheKey);
        set.headers = {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
        };
        return cached.value;
      }

      console.log('Cache miss for messages:', cacheKey);
      const db = await getDbo();

      const queryObj = {
        'MAP.type': 'message',
        'MAP.channel': decodedChannelId,
      };

      const col = db.collection('message');

      const count = await col.countDocuments(queryObj);

      const results = (await col
        .find(queryObj)
        .sort({ 'blk.t': -1 })
        .skip(skip)
        .limit(limit)
        .project({ _id: 0 })
        .toArray()) as Message[];

      const response: MessageResponse = {
        channel: decodedChannelId,
        page,
        limit,
        count,
        results,
      };

      await saveToRedis<CacheValue>(cacheKey, {
        type: 'messages',
        value: response,
      });

      set.headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      };
      return response;
    } catch (error: unknown) {
      console.error('Error processing messages request:', error);
      const message = error instanceof Error ? error.message : String(error);

      set.status = 500;
      set.headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      };
      return {
        error: 'Failed to fetch messages',
        details: message,
        timestamp: new Date().toISOString(),
      };
    }
  });

  app.get('/s/:collectionName?/:base64Query', async ({ params, set }) => {
    const { collectionName, base64Query: b64 } = params;
    set.headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    };

    const json = Buffer.from(b64, 'base64').toString();
    const db = await getDbo();

    console.log(chalk.blue('New change stream subscription on', collectionName));
    const query = JSON.parse(json);

    const pipeline = [{ $match: { operationType: 'insert' } }];
    const keys = Object.keys(query.q.find || {});
    for (const k of keys) {
      pipeline[0].$match[`fullDocument.${k}`] = query.q.find[k];
    }

    if (collectionName === '$all') {
      const collections = bitcoinSchemaCollections;
      const streams = collections.map((collection) => {
        const target = db.collection(collection);
        return target.watch(pipeline, { fullDocument: 'updateLookup' });
      });

      return new ReadableStream({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'open', data: [] })}\n\n`);

          streams.forEach((stream, index) => {
            const collection = collections[index];
            stream.on('change', (next: ChangeStreamDocument<BmapTx>) => {
              if (next.operationType === 'insert') {
                console.log(chalk.blue('New insert event in', collection), next.fullDocument.tx?.h);
                controller.enqueue(
                  `data: ${JSON.stringify({ type: collection, data: [next.fullDocument] })}\n\n`
                );
              }
            });

            stream.on('error', (e) => {
              console.log(chalk.blue(`Changestream error in ${collection} - closing SSE`), e);
              stream.close();
            });
          });

          const heartbeat = setInterval(() => {
            controller.enqueue(':heartbeat\n\n');
          }, 30000);

          return () => {
            clearInterval(heartbeat);
            for (const stream of streams) {
              stream.close();
            }
          };
        },
      });
    }

    const target = db.collection(collectionName);
    const changeStream = target.watch(pipeline, { fullDocument: 'updateLookup' });

    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'open', data: [] })}\n\n`);

        changeStream.on('change', (next: ChangeStreamDocument<BmapTx>) => {
          if (next.operationType === 'insert') {
            console.log(chalk.blue('New insert event in', collectionName), next.fullDocument.tx?.h);
            controller.enqueue(
              `data: ${JSON.stringify({ type: collectionName, data: [next.fullDocument] })}\n\n`
            );
          }
        });

        changeStream.on('error', (e) => {
          console.log(chalk.blue(`Changestream error in ${collectionName} - closing SSE`), e);
          changeStream.close();
          controller.close();
        });

        const heartbeat = setInterval(() => {
          controller.enqueue(':heartbeat\n\n');
        }, 30000);

        return () => {
          clearInterval(heartbeat);
          changeStream.close();
        };
      },
    });
  });
}
