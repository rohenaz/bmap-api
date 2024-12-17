import type { Elysia } from 'elysia';
import { getDbo } from './db.js';
import { readFromRedis, saveToRedis } from './cache.js';
import { getBAPIdByAddress } from './bap.js';
import type { BapIdentity } from './bap.js';
import type { CacheSigner } from './cache.js';

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
}