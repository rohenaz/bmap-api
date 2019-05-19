
# About
The BMAP Planaria only indexes B and MAP fields, making it lighter and faster than other alternatives such as [babel](https://babel.bitdb.network/). 
One of the key challenges in working with BMAP based applications has been the variable width of the MAP protocol. Because of this, it can be difficult to know which OP_RETURN pushdata contains the data you want. BMAP seeks to address this by avoiding fields keyed by pushdata indexes. Instead, BMAP knows the schema of the two protocols, and can simply provide field names that reflect their actual, human-readable names.

BMAP allows you to query using a human readable format. [bmapjs](https://github.com/rohenaz/bmap) node module to transform [TXO](https://github.com/interplanaria/txo) format into B and MAP data.

# Example Query
```
{
  "v": 3,
  "q": {
    "find": {
      "MAP.app": "tonicpow",
      "MAP.type": "campaign_request",
      "MAP.site_address": "15s8NZXNPv2duA4dr3mRwMGLNqvEi4AFyK",
      "MAP.ad_unit_id": "demo-example-one"
    },
    "limit": 50,
    "sort": { "blk.t":1 },
    "project": { "B": 1, "MAP": 1 }
  }
}
```

```
{
  "v": 3,
  "q": {
    "find": {
      "MAP.app": "metalens",
      "MAP.type": "comment"
    },
    "limit": 50,
    "sort": { "blk.t":1 },
    "project": { "B": 1, "MAP": 1 }
  }
}
```

# More Information
- [B Protocol](https://b.bitdb.network/)
- [MAP Protocol](https://github.com/rohenaz/MAP)
- [bmapjs](https://github.com/rohenaz/bmap)
- [TXO](https://github.com/interplanaria/txo)
