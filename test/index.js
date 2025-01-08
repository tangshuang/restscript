import { fetchObject, fetchArray } from './fetch.js';
import { RestScript } from '../es/index.js';

// ---------------------------------------

async function emptyObject() {
  const request = new RestScript({
    fetch: fetchObject,
  });
  const data = await request.run(`
    GET "url" -> {};
  `);
  console.log(data);
}

async function emptyArray() {
  const request = new RestScript({
    fetch: fetchArray,
  });
  const data = await request.run(`
    GET "url" -> [];
  `);
  console.log(data);
}

async function filterArray() {
  const request = new RestScript({
    fetch: fetchArray,
  });
  const data = await request.run(`
    GET "url" -> ["price>8": {}];
  `);
  console.log(data);
}

async function filterDeepNodeArray() {
  const request = new RestScript({
    fetch: fetchObject,
  });
  const data = await request.run(`
    GET "url" -> {
      data: {
        book_list: [
          "price<8": {
            id: number;
            book_title: string;
          }
        ]
      }
    };
  `);
  console.log(data);
}

// ---------------------------------------

(function() {
  emptyObject();
  emptyArray();
  filterArray();
  filterDeepNodeArray();
} ());
