# @aws-sdk/xml-builder

[![NPM version](https://img.shields.io/npm/v/@aws-sdk/xml-builder/latest.svg)](https://www.npmjs.com/package/@aws-sdk/xml-builder)
[![NPM downloads](https://img.shields.io/npm/dm/@aws-sdk/xml-builder.svg)](https://www.npmjs.com/package/@aws-sdk/xml-builder)

### :warning: Internal API :warning:

> This is an internal package.
> That means this is used as a dependency for other, public packages, but
> should not be taken directly as a dependency in your application's `package.json`.

> If you are updating the version of this package, for example to bring in a
> bug-fix, you should do so by updating your application lockfile with
> e.g. `npm up @scope/package` or equivalent command in another
> package manager, rather than taking a direct dependency.

---

## XML parsing in runtimes without `DOMParser`

The `browser` and `react-native` entry points (`dist-es/xml-parser.browser.js`)
parse XML with the global `DOMParser` when it is available. Some runtimes that
resolve the `browser` condition don't define `DOMParser`, for example
Cloudflare Workers/workerd and WebAssembly components built with
ComponentizeJS/StarlingMonkey (see
[#7375](https://github.com/aws/aws-sdk-js-v3/issues/7375)). In those runtimes,
`parseXML` falls back to the package's own dependency-free JavaScript parser
(`aws-xml-parser`, the same parser the Node.js entry point uses). The check is
`typeof DOMParser === "undefined"` and runs on each call, so the parser doesn't
depend on module-load order. Neither path depends on the global `Node` object.

Both parsers produce the same object shape for SDK responses. Entity and
numeric character references, including astral code points such as `&#x1F600;`,
decode the same way in both. A character reference above `U+10FFFF` is rejected
with an `@aws-sdk XML parse error`.
