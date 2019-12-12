# bmap-planaria
BMAP BitDB for building B + MAP based Bitcoin apps.

In a nutshell, BMAP planaria takes BOB transactions as an input, and filters for only transactions containing MAP attribute data. It then provides support for a number of known OP_RETURN protocols making queries very simple and easy to read.

```
{
  find: {
    "MAP.app": "tonicpow"
  }
}

```
TODO
<a href="https://b.map.sv/q/">Example</a>

# Warning
*This planaria is a work in progress. It is not ready for production use.*
It requires a fundemental solution to [this problem](https://github.com/interplanaria/planaria/issues/12) in order to be fully realized.

See readme in genes folder for planaria information
