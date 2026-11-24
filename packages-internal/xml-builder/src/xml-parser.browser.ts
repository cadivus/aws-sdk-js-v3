import { parseXML as parseXMLWithoutDOMParser } from "./aws-xml-parser";

let parser: DOMParser | undefined;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Uses DOMParser when the runtime provides it. Runtimes that resolve the
 * browser entry point without a DOM (Cloudflare workerd, StarlingMonkey /
 * ComponentizeJS WebAssembly components, some edge runtimes) fall back to the
 * dependency-free parser used in Node.js.
 *
 * Cases where the DOMParser path differs from fast-xml-parser:
 *
 * 1. Mixing text with nested tags (does not occur in AWS REST XML).
 * <mixed-text> hello, <bold>world</bold>, how are you?</mixed-text>
 *
 * @internal
 */
export function parseXML(xmlString: string): any {
  if (typeof DOMParser === "undefined") {
    return parseXMLWithoutDOMParser(xmlString);
  }

  if (!parser) {
    parser = new DOMParser();
  }

  const xmlDocument = parser.parseFromString(xmlString, "application/xml");

  if (xmlDocument.getElementsByTagName("parsererror").length > 0) {
    throw new Error("DOMParser XML parsing error.");
  }

  // Recursive function to convert XML nodes to JS object
  const xmlToObj = (node: Node): any => {
    if (node.nodeType === TEXT_NODE) {
      if (node.textContent?.trim()) {
        return node.textContent;
      }
    }

    if (node.nodeType === ELEMENT_NODE) {
      const element = node as Element;
      if (element.attributes.length === 0 && element.childNodes.length === 0) {
        return "";
      }

      const obj: any = {};

      const attributes = Array.from(element.attributes);
      for (const attr of attributes) {
        obj[`${attr.name}`] = attr.value;
      }

      const childNodes = Array.from(element.childNodes);
      for (const child of childNodes) {
        const childResult = xmlToObj(child);

        if (childResult != null) {
          const childName = child.nodeName;

          if (childNodes.length === 1 && attributes.length === 0 && childName === "#text") {
            return childResult;
          }

          if (childName in obj) {
            if (Array.isArray(obj[childName])) {
              obj[childName].push(childResult);
            } else {
              obj[childName] = [obj[childName], childResult];
            }
          } else {
            obj[childName] = childResult;
          }
        } else if (childNodes.length === 1 && attributes.length === 0) {
          return element.textContent;
        }
      }

      return obj;
    }

    return null;
  };

  return {
    [xmlDocument.documentElement.nodeName]: xmlToObj(xmlDocument.documentElement),
  };
}
