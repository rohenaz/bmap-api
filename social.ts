import cors from '@elysiajs/cors';
import type { BmapTx } from 'bmapjs';
import chalk from 'chalk';
import { Elysia } from 'elysia';
import { t } from 'elysia';
import type { Document, WithId } from 'mongodb';
import type { ChangeStreamDocument } from 'mongodb';
import type { ChangeStream } from 'mongodb';
import { getBAPIdByAddress } from './bap.js';
import type { BapIdentity, BapIdentityObject } from './bap.js';
import { normalize } from './bmap.js';
import { client, readFromRedis, saveToRedis } from './cache.js';
import type { CacheValue as BaseCacheValue, CacheError, CacheSigner } from './cache.js';
import { getDbo } from './db.js';

// Extend CacheValue type
export type CacheValue =
  | BaseCacheValue
  | {
      type: 'identities';
      value: Identity[];
    };

// Bitcoin schema collections to watch
const _bitcoinSchemaCollections = [
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
  signers: BapIdentity[];
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
  const relationships = new Map<string, RelationshipState>();

  async function getRequestorBapId(doc: BmapTx): Promise<string | null> {
    const address = doc?.AIP?.[0]?.address || doc?.AIP?.[0]?.signing_address;
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

    if (!reqBap || !tgtBap || !Array.isArray(doc.MAP)) continue;

    const otherBapId = reqBap === bapId ? tgtBap : reqBap;
    if (otherBapId && typeof otherBapId === 'string' && !relationships.has(otherBapId)) {
      relationships.set(otherBapId, { fromMe: false, fromThem: false, unfriended: false });
    }

    const rel = relationships.get(typeof otherBapId === 'string' ? otherBapId : '');
    if (!rel) continue;

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

// Define request schemas
const LikeRequest = t.Object({
  txids: t.Optional(t.Array(t.String())),
  messageIds: t.Optional(t.Array(t.String())),
});

const ChannelParams = t.Object({
  channelId: t.String(),
});

const MessageQuery = t.Object({
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

// Helper function to parse identity JSON
export function parseIdentity(
  identityValue: string | Record<string, unknown>
): Record<string, unknown> {
  if (typeof identityValue === 'object' && identityValue !== null) {
    return identityValue;
  }

  if (typeof identityValue === 'string') {
    try {
      const parsed = JSON.parse(identityValue);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
      return { alternateName: parsed };
    } catch {
      return { alternateName: identityValue };
    }
  }

  return { alternateName: String(identityValue) };
}

// Helper function to merge new signers into cache
async function updateSignerCache(newSigners: BapIdentity[]): Promise<void> {
  for (const signer of newSigners) {
    const signerKey = `signer-${signer.currentAddress}`;
    await saveToRedis<CacheValue>(signerKey, {
      type: 'signer',
      value: signer,
    });
  }
  // Clear the identities cache to force a refresh with new signers
  await client.del('identities');
}

// Helper function to resolve signers from messages
async function resolveSigners(messages: Message[]): Promise<BapIdentity[]> {
  const signerAddresses = new Set<string>();

  for (const msg of messages) {
    if (msg.AIP && Array.isArray(msg.AIP)) {
      for (const aip of msg.AIP) {
        const address = aip.algorithm_signing_component || aip.address;
        if (address) {
          signerAddresses.add(address);
        }
      }
    }
  }

  const signers = await Promise.all(
    Array.from(signerAddresses).map(async (address) => {
      try {
        const identity = await getBAPIdByAddress(address);
        if (identity) {
          // Update the signer cache with this identity
          const signerKey = `signer-${address}`;
          await saveToRedis<CacheValue>(signerKey, {
            type: 'signer',
            value: identity,
          });
          return identity;
        }
      } catch (error) {
        console.error(`Failed to resolve signer for address ${address}:`, error);
      }
      return null;
    })
  );

  const validSigners = signers.filter((s): s is BapIdentity => s !== null);

  // Update the cache with new signers
  await updateSignerCache(validSigners);

  return validSigners;
}

// Define the Identity interface
export interface Identity {
  idKey: string;
  paymail: string | null;
  displayName: string;
  icon: string | null;
}

export const IdentityResponse = t.Array(
  t.Object({
    idKey: t.String(),
    paymail: t.Union([t.String(), t.Null()]),
    displayName: t.String(),
    icon: t.Union([t.String(), t.Null()]),
  })
);

const ChannelResponse = t.Array(
  t.Object({
    channel: t.String(),
    creator: t.Union([t.String(), t.Null()]),
    last_message: t.Union([t.String(), t.Null()]),
    last_message_time: t.Number(),
    messages: t.Number(),
  })
);

const MessageResponse = t.Object({
  channel: t.String(),
  page: t.Number(),
  limit: t.Number(),
  count: t.Number(),
  results: t.Array(
    t.Object({
      tx: t.Object({
        h: t.String(),
      }),
      blk: t.Object({
        i: t.Number(),
        t: t.Number(),
      }),
      MAP: t.Array(
        t.Object({
          app: t.String(),
          type: t.String(),
          channel: t.String(),
          paymail: t.String(),
        })
      ),
      B: t.Array(
        t.Object({
          Data: t.Object({
            utf8: t.String(),
          }),
        })
      ),
      AIP: t.Optional(
        t.Array(
          t.Object({
            address: t.Optional(t.String()),
            algorithm_signing_component: t.Optional(t.String()),
          })
        )
      ),
    })
  ),
  signers: t.Array(
    t.Object({
      idKey: t.String(),
      rootAddress: t.String(),
      currentAddress: t.String(),
      addresses: t.Array(
        t.Object({
          address: t.String(),
          txId: t.String(),
          block: t.Optional(t.Number()),
        })
      ),
      identity: t.String(),
      identityTxId: t.String(),
      block: t.Number(),
      timestamp: t.Number(),
      valid: t.Boolean(),
    })
  ),
});

const LikeResponse = t.Array(
  t.Object({
    txid: t.String(),
    likes: t.Array(
      t.Object({
        tx: t.Object({
          h: t.String(),
        }),
        blk: t.Object({
          i: t.Number(),
          t: t.Number(),
        }),
        MAP: t.Array(
          t.Object({
            type: t.String(),
            tx: t.Optional(t.String()),
            messageID: t.Optional(t.String()),
            emoji: t.Optional(t.String()),
          })
        ),
        AIP: t.Optional(
          t.Array(
            t.Object({
              algorithm_signing_component: t.String(),
            })
          )
        ),
      })
    ),
    total: t.Number(),
    signers: t.Array(
      t.Object({
        idKey: t.String(),
        rootAddress: t.String(),
        currentAddress: t.String(),
        addresses: t.Array(
          t.Object({
            address: t.String(),
            txId: t.String(),
            block: t.Optional(t.Number()),
          })
        ),
        identity: t.String(),
        identityTxId: t.String(),
        block: t.Number(),
        timestamp: t.Number(),
        valid: t.Boolean(),
      })
    ),
  })
);

const FriendResponse = t.Object({
  friends: t.Array(t.String()),
  incoming: t.Array(t.String()),
  outgoing: t.Array(t.String()),
});

// Update CacheListResponse type
export interface CacheListResponse extends Array<Identity> {}

export const socialRoutes = new Elysia()
  .get(
    '/channels',
    async ({ set }) => {
      try {
        const cacheKey = 'channels';
        const cached = await readFromRedis<CacheValue>(cacheKey);

        console.log('channels cache key', cacheKey);
        if (cached?.type === 'channels') {
          console.log('Cache hit for channels');
          Object.assign(set.headers, {
            'Cache-Control': 'public, max-age=60',
          });
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
              creator: { $first: { $ifNull: ['$MAP.paymail', null] } },
              last_message: { $last: { $ifNull: ['$B.Data.utf8', null] } },
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
        const channels = results.map((r) => ({
          channel: r.channel,
          creator: r.creator || null,
          last_message: r.last_message || null,
          last_message_time: r.last_message_time,
          messages: r.messages,
        }));

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'channels',
          value: channels,
        });

        Object.assign(set.headers, {
          'Cache-Control': 'public, max-age=60',
        });
        return channels;
      } catch (error: unknown) {
        console.error('Error processing channels request:', error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to fetch channels: ${message}`);
      }
    },
    {
      response: ChannelResponse,
    }
  )
  .get(
    '/channels/:channelId/messages',
    async ({ params, query, set }) => {
      try {
        const { channelId } = params;
        if (!channelId) {
          throw new Error('Missing channel ID');
        }

        const decodedChannelId = decodeURIComponent(channelId);

        const page = query.page ? Number.parseInt(query.page, 10) : 1;
        const limit = query.limit ? Number.parseInt(query.limit, 10) : 100;

        if (Number.isNaN(page) || page < 1) {
          throw new Error('Invalid page parameter');
        }

        if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
          throw new Error('Invalid limit parameter');
        }

        const skip = (page - 1) * limit;

        const cacheKey = `messages:${decodedChannelId}:${page}:${limit}`;
        const cached = await readFromRedis<CacheValue>(cacheKey);

        if (cached?.type === 'messages') {
          console.log('Cache hit for messages:', cacheKey);
          Object.assign(set.headers, {
            'Cache-Control': 'public, max-age=60',
          });
          const response: MessageResponse = {
            ...cached.value,
            signers: cached.value.signers || [],
          };
          return response;
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

        // Normalize and validate each message
        const validatedResults = results.map((msg) => ({
          ...msg,
          tx: { h: msg.tx?.h || '' },
          blk: { i: msg.blk?.i || 0, t: msg.blk?.t || 0 },
          MAP: msg.MAP?.map((m) => ({
            app: m.app || '',
            type: m.type || '',
            channel: m.channel || '',
            paymail: m.paymail || '',
          })) || [
            {
              app: '',
              type: '',
              channel: '',
              paymail: '',
            },
          ],
          B: msg.B?.map((b) => ({
            Data: {
              utf8: b.Data?.utf8 || '',
            },
          })) || [
            {
              Data: {
                utf8: '',
              },
            },
          ],
        }));

        // Initialize empty signers array with proper type
        let signers: BapIdentity[] = [];

        // Only try to resolve signers if there are messages with AIP data
        const messagesWithAIP = results.filter((msg) => msg.AIP && msg.AIP.length > 0);
        if (messagesWithAIP.length > 0) {
          try {
            signers = await resolveSigners(messagesWithAIP);
            console.log(`Resolved ${signers.length} signers`);
          } catch (error) {
            console.error('Error resolving signers:', error);
            // Don't throw - continue with empty signers array
          }
        } else {
          console.log('No messages with AIP data found');
        }

        // Ensure signers array is properly initialized with all required fields
        const validatedSigners: BapIdentity[] = signers.map((signer) => ({
          idKey: signer.idKey || '',
          rootAddress: signer.rootAddress || '',
          currentAddress: signer.currentAddress || '',
          addresses: signer.addresses || [],
          identity:
            typeof signer.identity === 'string' ? signer.identity : JSON.stringify(signer.identity),
          identityTxId: signer.identityTxId || '',
          block: signer.block || 0,
          timestamp: signer.timestamp || 0,
          valid: signer.valid ?? true,
        }));

        const response: MessageResponse = {
          channel: channelId,
          page,
          limit,
          count,
          results: validatedResults,
          signers: validatedSigners,
        };

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'messages',
          value: response,
        });

        Object.assign(set.headers, {
          'Cache-Control': 'public, max-age=60',
        });
        return response;
      } catch (error: unknown) {
        console.error('Error fetching messages:', error);
        set.status = 500;
        // Return a properly structured response with empty arrays
        const errorResponse: MessageResponse = {
          channel: params.channelId || '',
          page: 1,
          limit: 100,
          count: 0,
          results: [
            {
              tx: { h: '' },
              blk: { i: 0, t: 0 },
              MAP: [{ app: '', type: '', channel: '', paymail: '' }],
              B: [{ Data: { utf8: '' } }],
            },
          ],
          signers: [],
        };
        return errorResponse;
      }
    },
    {
      params: ChannelParams,
      query: MessageQuery,
      response: MessageResponse,
    }
  )
  .post(
    '/likes',
    async ({ body }) => {
      try {
        const request = body as LikeRequest;
        if (!request.txids && !request.messageIds) {
          throw new Error('Must provide either txids or messageIds');
        }

        const db = await getDbo();
        const results: LikeResponse[] = [];

        if (request.txids) {
          for (const txid of request.txids) {
            const likes = (await db
              .collection('like')
              .find({
                'MAP.type': 'like',
                'MAP.tx': txid,
              })
              .toArray()) as unknown as Reaction[];

            const { signers } = await processLikes(likes);

            results.push({
              txid,
              likes,
              total: likes.length,
              signers,
            });
          }
        }

        if (request.messageIds) {
          for (const messageId of request.messageIds) {
            const likes = (await db
              .collection('like')
              .find({
                'MAP.type': 'like',
                'MAP.messageID': messageId,
              })
              .toArray()) as unknown as Reaction[];

            const { signers } = await processLikes(likes);

            results.push({
              txid: messageId,
              likes,
              total: likes.length,
              signers,
            });
          }
        }

        return results;
      } catch (error: unknown) {
        console.error('Error processing likes:', error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to process likes: ${message}`);
      }
    },
    {
      body: LikeRequest,
      response: LikeResponse,
    }
  )
  .get(
    '/friend/:bapId',
    async ({ params }) => {
      try {
        const { bapId } = params;
        if (!bapId) {
          throw new Error('Missing BAP ID');
        }

        const { allDocs, ownedAddresses } = await fetchAllFriendsAndUnfriends(bapId);
        return processRelationships(bapId, allDocs, ownedAddresses);
      } catch (error: unknown) {
        console.error('Error processing friend request:', error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to process friend request: ${message}`);
      }
    },
    {
      params: t.Object({
        bapId: t.String(),
      }),
      response: FriendResponse,
    }
  )
  .get(
    '/identities',
    async ({ set }) => {
      try {
        console.log('=== Starting /identities request ===');

        // Check Redis connection
        console.log('Checking Redis connection...');
        if (!client.isReady) {
          console.error('Redis client is not ready');
          set.status = 503;
          return [];
        }
        console.log('Redis client is ready');

        const cacheKey = 'identities';
        const cached = await readFromRedis<CacheValue | CacheError>(cacheKey);

        if (cached?.type === 'identities' && 'value' in cached && Array.isArray(cached.value)) {
          console.log('Cache hit for identities');
          Object.assign(set.headers, {
            'Cache-Control': 'public, max-age=60',
          });
          return cached.value;
        }

        console.log('Cache miss for identities');
        const idCacheKey = 'signer-*';
        const keys = await client.keys(idCacheKey);
        console.log(`Found ${keys.length} Redis keys:`, keys);

        if (!keys.length) {
          console.log('No identity keys found in Redis');
          return [];
        }

        const identities = await Promise.all(
          keys.map(async (k) => {
            try {
              console.log(`\nProcessing key: ${k}`);
              const cachedValue = await readFromRedis<CacheValue | CacheError>(k);
              console.log('Raw cached value:', cachedValue);

              if (!cachedValue) {
                console.log(`No value found for key: ${k}`);
                return null;
              }
              if (cachedValue.type !== 'signer') {
                console.log(`Invalid type for key ${k}:`, cachedValue.type);
                return null;
              }

              const identity = cachedValue.value;
              console.log('Identity value:', identity);
              if (!identity || !identity.idKey) {
                console.log('Invalid identity structure:', identity);
                return null;
              }

              const identityObj = parseIdentity(identity.identity);
              console.log('Parsed identity object:', identityObj);

              return {
                idKey: identity.idKey,
                paymail: (identityObj.paymail as string) || null,
                displayName:
                  (identityObj.alternateName as string) ||
                  (identityObj.name as string) ||
                  identity.idKey,
                icon:
                  (identityObj.image as string) ||
                  (identityObj.icon as string) ||
                  (identityObj.avatar as string) ||
                  null,
              };
            } catch (error) {
              console.error(`Error processing key ${k}:`, error);
              return null;
            }
          })
        );

        const filteredIdentities = identities.filter((id) => id !== null);

        console.log('\n=== Identity Processing Summary ===');
        console.log('Total keys found:', keys.length);
        console.log('Successfully processed:', filteredIdentities.length);
        console.log('Failed/invalid:', keys.length - filteredIdentities.length);
        console.log('Final identities:', JSON.stringify(filteredIdentities, null, 2));

        await saveToRedis<CacheValue>(cacheKey, {
          type: 'identities',
          value: filteredIdentities,
        });

        Object.assign(set.headers, {
          'Cache-Control': 'public, max-age=60',
        });
        return filteredIdentities;
      } catch (error: unknown) {
        console.error('=== Error in /identities endpoint ===');
        console.error('Error details:', error);
        console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
        set.status = 500;
        throw new Error(
          `Failed to fetch identities: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    {
      response: t.Array(
        t.Object({
          idKey: t.String(),
          paymail: t.Union([t.String(), t.Null()]),
          displayName: t.String(),
          icon: t.Union([t.String(), t.Null()]),
        })
      ),
    }
  );

// .get('/identities', async ({ set }) => {
//   try {
//     console.log('=== Starting /identities request ===');

//     // Check Redis connection
//     console.log('Checking Redis connection...');
//     if (!client.isReady) {
//       console.error('Redis client is not ready');
//       set.status = 503;
//       return { error: 'Redis client not ready', signers: [] };
//     }
//     console.log('Redis client is ready');

//     // Search for identity keys
//     console.log('Searching for Redis keys...');
//     const idCacheKey = 'signer-*';
//     const keys = await client.keys(idCacheKey);
//     console.log(`Found ${keys.length} Redis keys:`, keys);

//     if (!keys.length) {
//       console.log('No identity keys found in Redis');
//       return { message: 'No identities found', signers: [] };
//     }

//     // Process each identity
//     console.log('Processing identities...');
//     const identities = await Promise.all(
//       keys.map(async (k) => {
//         try {
//           console.log(`\nProcessing key: ${k}`);
//           const cachedValue = await readFromRedis<CacheValue>(k);
//           console.log('Raw cached value:', cachedValue);

//           if (!cachedValue) {
//             console.log(`No value found for key: ${k}`);
//             return null;
//           }
//           if (cachedValue.type !== 'signer') {
//             console.log(`Invalid type for key ${k}:`, cachedValue.type);
//             return null;
//           }

//           const identity = cachedValue.value;
//           console.log('Identity value:', identity);
//           if (!identity || !identity.idKey) {
//             console.log('Invalid identity structure:', identity);
//             return null;
//           }

//           // Parse the identity into an object
//           const identityObj = parseIdentity(identity.identity);
//           console.log('Parsed identity object:', identityObj);

//           // Return the shape that the frontend expects
//           return {
//             idKey: identity.idKey,
//             paymail: identityObj.paymail || identity.paymail,
//             displayName: identityObj.alternateName || identityObj.name || identity.idKey,
//             icon: identityObj.image || identityObj.icon || identityObj.avatar,
//           };
//         } catch (error) {
//           console.error(`Error processing key ${k}:`, error);
//           return null;
//         }
//       })
//     );

//     const filteredIdentities = identities.filter(
//       (id): id is NonNullable<typeof id> => id !== null
//     );

//     console.log('\n=== Identity Processing Summary ===');
//     console.log('Total keys found:', keys.length);
//     console.log('Successfully processed:', filteredIdentities.length);
//     console.log('Failed/invalid:', keys.length - filteredIdentities.length);
//     console.log('Final identities:', JSON.stringify(filteredIdentities, null, 2));

//     return { message: 'Success', signers: filteredIdentities };
//   } catch (e) {
//     console.error('=== Error in /identities endpoint ===');
//     console.error('Error details:', e);
//     console.error('Stack trace:', e instanceof Error ? e.stack : 'No stack trace');
//     set.status = 500;
//     return { error: 'Failed to get identities', signers: [] };
//   }
// })

// For backward compatibility
export const registerSocialRoutes = (app: Elysia) => app.use(socialRoutes);
