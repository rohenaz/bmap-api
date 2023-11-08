// {
//       "rootAddress": "13ZNtS7f3Yb5QiYsJgNpXq7S994hcPLaKv",
//       "currentAddress": "1HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY",
//       "addresses": [
//           {
//               "address": "1HjTer9VgkfeNaFibPB8EWUGJLEg8yAHfY",
//               "txId": "f39575e7ac17f8590f42aa2d9f17b743d816985e85632303281fe7c84c3186b3"
//           }
//       ],
//       "identity": "{\"@context\":\"https://schema.org\",\"@type\":\"Person\",\"alternateName\":\"WildSatchmo\",\"logo\":\"bitfs://a53276421d2063a330ebbf003ab5b8d453d81781c6c8440e2df83368862082c5.out.1.1\",\"image\":\"\",\"homeLocation\":{\"@type\":\"Place\",\"name\":\"Bitcoin\"},\"url\":\"https://tonicpow.com\",\"paymail\":\"satchmo@moneybutton.com\"}",
//       "identityTxId": "e7becb2968a6afe0f690cbe345fba94b8e4a7da6a014a5d52b080a7d6913c281",
//       "idKey": "Go8vCHAa4S6AhXKTABGpANiz35J",
//       "block": 594320,
//       "timestamp": 1699391776,
//       "valid": false
//   }

export type BapIdentity = {
  rootAddress: string
  currentAddress: string
  addresses: {
    address: string
    txId: string
  }[]
  identity: string
  identityTxId: string
  idKey: string
  block: number
  timestamp: number
  valid: boolean
}

const bapApiUrl = `https://bap-api.com/v1/`

export const getBAPIdByAddress = async (
  address: string,
  block?: number,
  timestamp?: number
): Promise<BapIdentity | undefined> => {
  try {
    let payload = {
      address,
    }
    if (block) {
      payload['block'] = block
    }
    if (timestamp) {
      payload['timestamp'] = timestamp
    }
    const result = await fetch(`${bapApiUrl}/identity/validByAddress`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const data = await result.json()

    if (data && data.status === 'OK' && data.result) {
      return data.result
    }
    return undefined
  } catch (e) {
    console.log(e)
    throw e
  }
}
