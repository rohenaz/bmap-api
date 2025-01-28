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
  mePublicKey?: string;
  themPublicKey?: string;
  unfriended: boolean;
}

interface FriendshipResponse {
  friends: Friend[];
  incoming: string[];
  outgoing: string[];
}

interface Friend {
  bapID: string;
  themPublicKey: string;
  mePublicKey: string;
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

export interface DMResponse {
  bapID: string;
  page: number;
  limit: number;
  count: number;
  results: Message[];
  signers: BapIdentity[];
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
    paymail?: string;
    context?: string;
    channel?: string;
    bapID?: string;
  }[];
  B: {
    Data: {
      utf8: string;
      data?: string;
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
  console.log('\n=== fetchAllFriendsAndUnfriends ===');
  console.log('BAP ID:', bapId);

  const dbo = await getDbo();

  const idData = await fetchBapIdentityData(bapId);
  if (!idData || !idData.addresses) {
    throw new Error(`No identity found for ${bapId}`);
  }

  const ownedAddresses = new Set<string>(idData.addresses.map((a) => a.address));
  console.log('Owned addresses:', [...ownedAddresses]);

  // Get incoming friend requests (where this BAP ID is the target)
  const incomingFriends = (await dbo
    .collection('friend')
    .find({ 'MAP.type': 'friend', 'MAP.bapID': bapId })
    .toArray()) as unknown as BmapTx[];

  console.log('Incoming friends count:', incomingFriends.length);
  console.log(
    'Incoming friends:',
    JSON.stringify(
      incomingFriends.map((f) => ({
        txid: f.tx?.h,
        bapID: f.MAP?.[0]?.bapID,
        address: f.AIP?.[0]?.algorithm_signing_component || f.AIP?.[0]?.address,
      })),
      null,
      2
    )
  );

  // Get outgoing friend requests (where this BAP ID's addresses are the source)
  const outgoingFriends = (await dbo
    .collection('friend')
    .find({
      'MAP.type': 'friend',
      $or: [
        { 'AIP.algorithm_signing_component': { $in: [...ownedAddresses] } },
        { 'AIP.address': { $in: [...ownedAddresses] } },
      ],
    })
    .toArray()) as unknown as BmapTx[];

  // Try to get unfriend documents if the collection exists
  let incomingUnfriends: BmapTx[] = [];
  let outgoingUnfriends: BmapTx[] = [];

  try {
    const collections = await dbo.listCollections().toArray();
    const hasUnfriendCollection = collections.some((c) => c.name === 'unfriend');

    if (hasUnfriendCollection) {
      incomingUnfriends = (await dbo
        .collection('unfriend')
        .find({ 'MAP.type': 'unfriend', 'MAP.bapID': bapId })
        .toArray()) as unknown as BmapTx[];

      outgoingUnfriends = (await dbo
        .collection('unfriend')
        .find({
          'MAP.type': 'unfriend',
          $or: [
            { 'AIP.algorithm_signing_component': { $in: [...ownedAddresses] } },
            { 'AIP.address': { $in: [...ownedAddresses] } },
          ],
        })
        .toArray()) as unknown as BmapTx[];
    }
  } catch (error) {
    console.warn('Failed to query unfriend collection:', error);
  }

  console.log('Outgoing friends count:', outgoingFriends.length);
  console.log(
    'Outgoing friends:',
    JSON.stringify(
      outgoingFriends.map((f) => ({
        txid: f.tx?.h,
        bapID: f.MAP?.[0]?.bapID,
        address: f.AIP?.[0]?.algorithm_signing_component || f.AIP?.[0]?.address,
      })),
      null,
      2
    )
  );

  const allDocs = [
    ...incomingFriends,
    ...incomingUnfriends,
    ...outgoingFriends,
    ...outgoingUnfriends,
  ];
  allDocs.sort((a, b) => (a.blk?.i ?? 0) - (b.blk?.i ?? 0));

  console.log('Total documents:', allDocs.length);
  return { allDocs, ownedAddresses };
}

async function processRelationships(
  bapId: string,
  docs: BmapTx[],
  ownedAddresses: Set<string>
): Promise<FriendshipResponse> {
  console.log('\n=== processRelationships ===');
  console.log('Processing relationships for BAP ID:', bapId);
  console.log('Number of documents:', docs.length);
  console.log('Owned addresses:', [...ownedAddresses]);

  const relationships = new Map<string, RelationshipState>();

  async function getRequestorBapId(doc: BmapTx): Promise<string | null> {
    // Check all possible address fields
    const address = doc?.AIP?.[0]?.algorithm_signing_component || doc?.AIP?.[0]?.address;
    if (!address) {
      console.log('No address found in document:', doc.tx?.h);
      return null;
    }

    if (ownedAddresses.has(address)) {
      console.log('Address matches owned address:', address);
      return bapId;
    }

    console.log('Looking up BAP ID for address:', address);
    const otherIdentity = await getBAPIdByAddress(address);
    if (!otherIdentity) {
      console.log('No identity found for address:', address);
      return null;
    }
    console.log('Found BAP ID for address:', otherIdentity.idKey);
    return otherIdentity.idKey;
  }

  const requestors = await Promise.all(docs.map((doc) => getRequestorBapId(doc)));
  console.log('Resolved requestors:', requestors);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const reqBap = requestors[i];
    const tgtBap = doc?.MAP?.[0]?.bapID;
    const publicKey = doc?.MAP?.[0]?.publicKey;

    console.log('\nProcessing document:', doc.tx?.h);
    console.log('Requestor BAP:', reqBap);
    console.log('Target BAP:', tgtBap);

    if (!reqBap || !tgtBap || !Array.isArray(doc.MAP)) {
      console.log('Skipping document - missing required fields');
      continue;
    }

    const otherBapId = reqBap === bapId ? tgtBap : reqBap;
    console.log('Other BAP ID:', otherBapId);

    if (otherBapId && typeof otherBapId === 'string' && !relationships.has(otherBapId)) {
      console.log('Creating new relationship for:', otherBapId);
      relationships.set(otherBapId, { fromMe: false, fromThem: false, unfriended: false });
    }

    const rel = relationships.get(typeof otherBapId === 'string' ? otherBapId : '');
    if (!rel) {
      console.log('No relationship found for:', otherBapId);
      continue;
    }

    const isFriend = doc?.MAP?.[0]?.type === 'friend';
    const isUnfriend = doc?.MAP?.[0]?.type === 'unfriend';
    const isFromMe = reqBap === bapId;

    console.log('Document type:', isFriend ? 'friend' : isUnfriend ? 'unfriend' : 'unknown');
    console.log('Is from me:', isFromMe);

    if (isUnfriend) {
      console.log('Processing unfriend');
      rel.unfriended = true;
      rel.fromMe = false;
      rel.fromThem = false;
    } else if (isFriend) {
      console.log('Processing friend');
      if (rel.unfriended) {
        rel.unfriended = false;
      }
      if (isFromMe) {
        rel.fromMe = true;
        rel.mePublicKey = publicKey;
      } else {
        rel.fromThem = true;
        rel.themPublicKey = publicKey;
      }
    }

    console.log(
      'Updated relationship:',
      JSON.stringify({
        otherBapId,
        fromMe: rel.fromMe,
        fromThem: rel.fromThem,
        unfriended: rel.unfriended,
      })
    );
  }

  const friends: Friend[] = [];
  const incoming: string[] = [];
  const outgoing: string[] = [];

  console.log('\nFinal relationships:');
  for (const [other, rel] of relationships.entries()) {
    console.log('Processing final relationship:', other, JSON.stringify(rel));

    if (rel.unfriended) {
      console.log('Skipping unfriended relationship:', other);
      continue;
    }
    if (rel.fromMe && rel.fromThem) {
      console.log('Adding mutual friend:', other);
      friends.push({
        bapID: other,
        mePublicKey: rel.mePublicKey || '',
        themPublicKey: rel.themPublicKey || '',
      });
    } else if (rel.fromMe && !rel.fromThem) {
      console.log('Adding outgoing friend:', other);
      outgoing.push(other);
    } else if (!rel.fromMe && rel.fromThem) {
      console.log('Adding incoming friend:', other);
      incoming.push(other);
    }
  }

  console.log('\nFinal results:');
  console.log('Friends:', friends);
  console.log('Incoming:', incoming);
  console.log('Outgoing:', outgoing);

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
  rootAddress: string;
  currentAddress: string;
  addresses: {
    address: string;
    txId: string;
    block: number | undefined;
  }[];
  identity: string;
  identityTxId: string;
  block: number;
  timestamp: number;
  valid: boolean;
}

export const IdentityResponse = t.Array(
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

const DMResponse = t.Object({
  bapID: t.String(),
  page: t.Number(),
  limit: t.Number(),
  count: t.Number(),
  results: t.Array(
    t.Object({
      timestamp: t.Number(),
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
          bapID: t.String(),
        })
      ),
      B: t.Array(
        t.Object({
          Data: t.Object({
            utf8: t.String(),
            data: t.String(),
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
            data: t.Optional(t.String()),
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
  friends: t.Array(
    t.Object({
      bapID: t.String(),
      mePublicKey: t.String(),
      themPublicKey: t.String(),
    })
  ),
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
      detail: {
        tags: ['social'],
        description: 'Get list of all message channels',
        summary: 'List channels',
        responses: {
          200: {
            description: 'List of channels with their latest messages',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      channel: { type: 'string', description: 'Channel identifier' },
                      creator: {
                        type: 'string',
                        nullable: true,
                        description: 'Channel creator paymail',
                      },
                      last_message: {
                        type: 'string',
                        nullable: true,
                        description: 'Most recent message',
                      },
                      last_message_time: {
                        type: 'number',
                        description: 'Timestamp of last message',
                      },
                      messages: { type: 'number', description: 'Total message count' },
                    },
                  },
                },
              },
            },
          },
        },
      },
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
            channel: channelId,
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
              data: b.Data?.data,
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
              B: [{ Data: { utf8: '', data: '' } }],
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
      detail: {
        tags: ['social'],
        description: 'Get messages from a specific channel',
        summary: 'Get channel messages',
        parameters: [
          {
            name: 'channelId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Channel identifier',
          },
          {
            name: 'page',
            in: 'query',
            schema: { type: 'string' },
            description: 'Page number for pagination',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'string' },
            description: 'Number of messages per page',
          },
        ],
        responses: {
          200: {
            description: 'Channel messages with signer information',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    channel: { type: 'string' },
                    page: { type: 'number' },
                    limit: { type: 'number' },
                    count: { type: 'number' },
                    results: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          tx: { type: 'object', properties: { h: { type: 'string' } } },
                          blk: {
                            type: 'object',
                            properties: {
                              i: { type: 'number' },
                              t: { type: 'number' },
                            },
                          },
                          MAP: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                app: { type: 'string' },
                                type: { type: 'string' },
                                channel: { type: 'string' },
                                paymail: { type: 'string' },
                              },
                            },
                          },
                          B: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                Data: {
                                  type: 'object',
                                  properties: {
                                    utf8: { type: 'string' },
                                    data: { type: 'string' },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    signers: {
                      type: 'array',
                      items: {
                        $ref: '#/components/schemas/BapIdentity',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
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
      detail: {
        tags: ['social'],
        description: 'Get likes for transactions or messages',
        summary: 'Get likes',
        requestBody: {
          description: 'Transaction IDs or Message IDs to get likes for',
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  txids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of transaction IDs',
                  },
                  messageIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of message IDs',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Likes with signer information',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      txid: { type: 'string' },
                      likes: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            tx: { type: 'object', properties: { h: { type: 'string' } } },
                            blk: {
                              type: 'object',
                              properties: {
                                i: { type: 'number' },
                                t: { type: 'number' },
                              },
                            },
                            MAP: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  type: { type: 'string' },
                                  tx: { type: 'string' },
                                  messageID: { type: 'string' },
                                  emoji: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                      total: { type: 'number' },
                      signers: {
                        type: 'array',
                        items: {
                          $ref: '#/components/schemas/BapIdentity',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
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
      detail: {
        tags: ['social'],
        description: 'Get friend relationships for a BAP ID',
        summary: 'Get friends',
        parameters: [
          {
            name: 'bapId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'BAP Identity Key',
          },
        ],
        responses: {
          200: {
            description: 'Friend relationships',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    friends: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Mutual friends (BAP IDs)',
                    },
                    incoming: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Incoming friend requests (BAP IDs)',
                    },
                    outgoing: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Outgoing friend requests (BAP IDs)',
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
  )
  .get(
    '/@/:bapId/messages',
    async ({ params, query, set }) => {
      try {
        const response = await getDirectMessages({
          bapId: params.bapId,
          page: query.page ? Number.parseInt(query.page, 10) : 1,
          limit: query.limit ? Number.parseInt(query.limit, 10) : 100,
        });

        Object.assign(set.headers, { 'Cache-Control': 'public, max-age=60' });
        return response;
      } catch (error) {
        console.error('DM messages error:', error);
        set.status = 500;
        return {
          bapID: params.bapId,
          page: 1,
          limit: 100,
          count: 0,
          results: [],
          signers: [],
        };
      }
    },
    {
      params: t.Object({ bapId: t.String() }),
      query: MessageQuery,
      response: DMResponse,
      detail: {
        tags: ['social'],
        description: 'Get encrypted direct messages for a BAP ID',
        parameters: [
          {
            name: 'bapId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Recipient BAP Identity Key',
          },
        ],
      },
    }
  )
  .get(
    '/@/:bapId/messages/:targetBapId',
    async ({ params, query, set }) => {
      try {
        const response = await getDirectMessages({
          bapId: params.bapId,
          targetBapId: params.targetBapId,
          page: query.page ? Number.parseInt(query.page, 10) : 1,
          limit: query.limit ? Number.parseInt(query.limit, 10) : 100,
        });

        Object.assign(set.headers, { 'Cache-Control': 'public, max-age=60' });
        return response;
      } catch (error) {
        console.error('DM messages error:', error);
        set.status = 500;
        return {
          bapID: params.bapId,
          page: 1,
          limit: 100,
          count: 0,
          results: [],
          signers: [],
        };
      }
    },
    {
      params: t.Object({ bapId: t.String(), targetBapId: t.String() }),
      query: MessageQuery,
      response: DMResponse,
      detail: {
        tags: ['social'],
        description: 'Get encrypted direct messages between two BAP IDs',
        parameters: [
          {
            name: 'bapId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Recipient BAP Identity Key',
          },
          {
            name: 'targetBapId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Target BAP Identity Key',
          },
        ],
      },
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

        // First try to get the cached identities list
        const identitiesCacheKey = 'identities';
        const cachedIdentities = await readFromRedis<CacheValue | CacheError>(identitiesCacheKey);

        if (cachedIdentities?.type === 'identities' && Array.isArray(cachedIdentities.value)) {
          console.log('Using cached identities list');
          Object.assign(set.headers, {
            'Cache-Control': 'public, max-age=60',
          });
          return cachedIdentities.value;
        }

        // If no cached list, get all signer-* keys from Redis
        console.log('No cached identities list, checking individual signer caches');
        const signerKeys = await client.keys('signer-*');
        console.log(`Found ${signerKeys.length} cached signers`);

        if (!signerKeys.length) {
          console.log('No cached signers found');
          return [];
        }

        // Get all cached signers
        const identities = await Promise.all(
          signerKeys.map(async (key) => {
            try {
              const cachedValue = await readFromRedis<CacheValue | CacheError>(key);
              if (cachedValue?.type === 'signer' && 'value' in cachedValue) {
                const identity = cachedValue.value;
                if (identity && validateSignerData(identity).isValid) {
                  return {
                    idKey: identity.idKey || '',
                    rootAddress: identity.rootAddress || '',
                    currentAddress: identity.currentAddress || '',
                    addresses: Array.isArray(identity.addresses)
                      ? identity.addresses.map((addr) => ({
                          address: addr.address || '',
                          txId: addr.txId || '',
                          block: typeof addr.block === 'number' ? addr.block : undefined,
                        }))
                      : [],
                    identity:
                      typeof identity.identity === 'string'
                        ? identity.identity
                        : JSON.stringify(identity.identity || {}),
                    identityTxId: identity.identityTxId || '',
                    block: typeof identity.block === 'number' ? identity.block : 0,
                    timestamp: typeof identity.timestamp === 'number' ? identity.timestamp : 0,
                    valid: typeof identity.valid === 'boolean' ? identity.valid : true,
                  };
                }
              }
              return null;
            } catch (error) {
              console.error(`Error processing cached signer ${key}:`, error);
              return null;
            }
          })
        );

        const filteredIdentities = identities.filter((id): id is Identity => {
          if (!id) return false;
          return (
            typeof id.idKey === 'string' &&
            typeof id.rootAddress === 'string' &&
            typeof id.currentAddress === 'string' &&
            Array.isArray(id.addresses) &&
            typeof id.identity === 'string' &&
            typeof id.identityTxId === 'string' &&
            typeof id.block === 'number' &&
            typeof id.timestamp === 'number' &&
            typeof id.valid === 'boolean'
          );
        });

        console.log('\n=== Identity Processing Summary ===');
        console.log('Total cached signers:', signerKeys.length);
        console.log('Successfully processed:', filteredIdentities.length);
        console.log('Failed/invalid:', signerKeys.length - filteredIdentities.length);

        // Cache the filtered list
        await saveToRedis<CacheValue>(identitiesCacheKey, {
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
        return [];
      }
    },
    {
      response: IdentityResponse,
      detail: {
        tags: ['identities'],
        description: 'Get all known BAP identities',
        summary: 'List identities',
        responses: {
          200: {
            description: 'List of BAP identities',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/BapIdentity',
                  },
                },
              },
            },
          },
        },
      },
    }
  );

// Shared function for fetching messages
async function getDirectMessages({
  bapId,
  targetBapId = null,
  page = 1,
  limit = 100,
}: {
  bapId: string;
  targetBapId?: string | null;
  page: number;
  limit: number;
}): Promise<DMResponse> {
  const skip = (page - 1) * limit;

  // Get current address for BAP ID
  const identity = await fetchBapIdentityData(bapId);
  if (!identity?.currentAddress) {
    throw new Error('Invalid BAP identity');
  }

  // Add this block to fetch target identity
  let targetIdentity: BapIdentity | null = null;
  if (targetBapId) {
    targetIdentity = await fetchBapIdentityData(targetBapId);
    if (!targetIdentity?.currentAddress) {
      throw new Error('Invalid target BAP identity');
    }
  }

  const db = await getDbo();
  const messageQuery = targetBapId
    ? {
        $and: [
          { 'MAP.type': 'message' },
          {
            $or: [
              {
                'MAP.bapID': targetBapId,
                'AIP.algorithm_signing_component': identity.currentAddress,
              },
              {
                'MAP.bapID': bapId,
                'AIP.algorithm_signing_component': targetIdentity.currentAddress,
              },
            ],
          },
        ],
      }
    : {
        'MAP.type': 'message',
        'MAP.bapID': bapId,
      };

  const col = db.collection('message');
  const results = (await col
    .find(messageQuery)
    .sort({ 'blk.t': -1 })
    .skip(skip)
    .limit(limit)
    .project({ _id: 0 })
    .toArray()) as Message[];

  const count = results.length;

  let signers: BapIdentity[] = [];
  const messagesWithAIP = results.filter((msg) => msg.AIP?.length);
  if (messagesWithAIP.length) {
    signers = await resolveSigners(messagesWithAIP);
  }

  return {
    bapID: bapId,
    page,
    limit,
    count,
    results: results.map((msg) => ({
      ...msg,
      MAP: msg.MAP.map((m) => ({
        ...m,
        bapID: m.bapID || '',
      })),
      B: msg.B.map((b) => ({
        Data: {
          utf8: b.Data?.utf8 || '',
          data: b.Data?.data || '',
        },
      })),
    })),
    signers: signers.map((s) => ({
      ...s,
      identityTxId: s.identityTxId || '',
      identity: typeof s.identity === 'string' ? s.identity : JSON.stringify(s.identity) || '',
    })),
  };
}
