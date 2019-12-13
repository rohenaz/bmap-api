# bmap-planaria
BMAPjs based Planaria for building 'BMAP' Bitcoin apps.

In a nutshell, this [Planaria](https://github.com/interplanaria/neonplanaria) takes BOB transactions as an input, and filters for only transactions containing MAP attribute data. It then provides support for a number of known OP_RETURN protocols making queries nicer:

```
{
  find: {
    "MAP.app": "tonicpow"
  }
}

```

# Examples
[MAP.app = TonicPow](https://b.map.sv/query/ewogICJ2IjogMywKICAicSI6IHsKICAgICJmaW5kIjogewogICAgICAiTUFQLmFwcCI6ICJ0b25pY3BvdyIKICAgIH0sCiAgICAic29ydCI6IHsgImJsay5pIjogLTEgfSwKICAgICJsaW1pdCI6IDEwCiAgfQp9)

[BITPIC.paymail = satchmo@moneybutton](https://b.map.sv/query/ewogICJ2IjogMywKICAicSI6IHsKICAgICJmaW5kIjogewogICAgICAiQklUUElDLnBheW1haWwiOiAic2F0Y2htb0Btb25leWJ1dHRvbi5jb20iCiAgICB9LAogICAgImxpbWl0IjogMTAKICB9Cn0=)

[BITKEY.paymail = satchmo@moneybutton](https://b.map.sv/query/ewogICJ2IjogMywKICAicSI6IHsKICAgICJmaW5kIjogewogICAgICAiQklUS0VZLnBheW1haWwiOiAic2F0Y2htb0Btb25leWJ1dHRvbi5jb20iCiAgICB9LAogICAgImxpbWl0IjogMTAKICB9Cn0=)


# BMAPjs
This Planaria returns data in BMAP format:
[BMAPjs](https://github.com/rohenaz/bmap) - [BOB](https://github.com/interplanaria/bpu) Parser

# Warning
*This planaria is a work in progress. It is not ready for production use.*
It requires a fundemental solution to [this problem](https://github.com/interplanaria/planaria/issues/12) in order to be fully realized.

See readme in genes folder for planaria information
