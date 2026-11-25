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

The `browser` and `react-native` builds (`dist-es/xml-parser.browser.js`) parse
XML with the global `DOMParser`. Some runtimes resolve the browser build but
don't define `DOMParser`, for example Web Workers and service workers
(`DOMParser` is only exposed on `Window`), Cloudflare workerd and WebAssembly
components on StarlingMonkey/ComponentizeJS (see
[#7375](https://github.com/aws/aws-sdk-js-v3/issues/7375)).

In those runtimes, `parseXML` uses the dependency-free parser from the Node.js
build (`xml-parser.ts`) instead. The `typeof DOMParser === "undefined"` check
runs on every call, so it doesn't depend on module load order. When `DOMParser`
is defined, it's still used.
