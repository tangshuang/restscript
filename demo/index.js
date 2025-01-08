import { RestScript } from '../es/index.js'
import { ScopeX } from 'scopex'
import { parse, tokenize } from '../es/compiler.js';

// 最基础用法
async function basic() {
  const data = await RestScript.run(`
    GET "https://api.github.com/search/repositories?q={keyword}" -> {
      /**
       * 多行注释效果
       */
      items: [
        {
          id: string
          full_name
          description
          html_url
        }
      ],
    }
  `, { keyword: 'js' })
  console.log('basic:', data)
}

// POST请求
async function post() {
  const fetch = (url, config, data) => {
    console.log('postData:', data)
    return {
      name: 'tomy',
      age: 10,
      height: 100,
    }
  }
  const data = await new RestScript({ fetch }).run(`
    POST "http://localhost:1333/post.json" + {
      id
      name
    } -> {
      name
      age: string
    }
  `, null, {
    id: '123',
    name: 'tomy',
    weight: 123,
  })
  console.log('post:', data)
}

// Headers
async function headers() {
  const data = await RestScript.run(`
    GET "https://api.github.com/search/repositories?q={keyword}" \\
    // 换行效果
    -H "Content-Type: application/json" \\
    -> {
      items
    }
  `, { keyword: 'react' })
  console.log('headers:', data)
}

// COMPOSE
async function compose() {
  const data = await new RestScript({
    scopex: ScopeX,
  }).run(`
    GET "https://api.github.com/search/repositories?q=reactjs" -> { total_count } as React
    GET "https://api.github.com/search/repositories?q=vuejs" -> { total_count } as Vue
    COMPOSE -> {
      react_total: (React.total_count)
      vue_total: (Vue.total_count)
      total: (React.total_count + Vue.total_count)
    }
  `)
  console.log('compose:', data)
}

// AWAIT
async function wait() {
  const data = await RestScript.run(`
    GET "https://api.github.com/search/repositories?q=reactjs" -> {
      items: [
        {
          full_name
        }
      ]
    } as React

    AWAIT React

    // 在后面的请求中，使用前面的请求的结果
    GET "https://api.github.com/search/repositories?q=(React.items.0.full_name)" -> {
      items: [
        {
          full_name
        }
      ]
      total_count
    }
  `)
  console.log('await:', data)
}

// 自定义格式器
async function shapes() {
  const data = await new RestScript({
    shapes: {
      date: (sep = '-') => function(value) {
        if (typeof value === 'number') {
          const date = new Date(value)
          return `${date.getFullYear()}${sep}${date.getMonth() + 1}${sep}${date.getDate()}`
        }
        return (value + '').substring(0, 10).replace(/\-/g, sep)
      },
    },
  }).run(`
    GET "https://api.github.com/search/repositories?q=reactjs" -> {
      items: [
        {
          full_name
          created_at: date("/")
        }
      ]
    }
  `)
  console.log('shape date:', data)
}

// 修饰符
async function decorate() {
  const data = await RestScript.run(`
    GET "https://api.github.com/search/repositories?q=reactjs" -> {
      /**
       * 将后端的items字段名映射为前端的item字段名
       * 将后端返回的items强制转换为对象，强制转换时，会使用第一个元素作为对象
       */
      item~items!: {
        full_name
        // 后端没有返回这个字段，前端拿到的结果就不会出现这个字段
        date?
        // 后端没有返回这个字段时，仍然会出现这个字段，赋值为null
        empty??
      }
    }
  `)
  console.log('decorate:', data)
}

// 片段
async function fragment() {
  const data = await RestScript.run(`
    DEFINE libraryInfo: {
      full_name
      url
    }
    GET "https://api.github.com/search/repositories?q=reactjs" -> {
      items: [&libraryInfo]
    } as React
    GET "https://api.github.com/search/repositories?q=vuejs" -> {
      items: [&libraryInfo]
    } as Vue
    COMPOSE -> {
      react: (React.items)
      vuew: (Vue.items)
    }
  `)
  console.log('fragment:', data)
}

async function fns() {
  const request = new RestScript({
    fns: {
      COUNT(items) {
        return items.length
      },
    },
    scopex: ScopeX,
  })

  const data = await request.run(`
    GET "https://api.github.com/search/repositories?q=reactjs" -> {
      items: [
        {
          id: string
          full_name
          description
          html_url
        }
      ],
    } as Data

    COMPOSE -> {
      count: (COUNT(Data.items))
    }
  `)
  console.log('fns:', data)
}

async function mock() {
  const data = await RestScript.mock(`
    FRAGMENT DATA: {
      name: string
      age: number
      children?: [&DATA]
    }

    GET "" -> {
      code: number
      data: &DATA
    }
  `)
  console.log('mock:', data)
}

async function debug() {
  const request = new RestScript({
    debug({
      url,
      should,
      receive,
      keyPath,
      command,
    }) {
      console.error(`${url || command} ${keyPath.join('.') || '-'} should be "${should}" but receive:`, receive)
    }
  })
  await request.run(`
  GET "https://api.github.com/search/repositories?q=reactjs" -> {
    items: [
      {
        id: string
        full_name
        description
        html_url
      }
    ],
  } as Data

  COMPOSE -> {
    count: (COUNT(Data.items))
  }
`)
}

async function normal() {
  const request = new RestScript({
    async fetch() {
      return true;
    },
  })
  await request.run(`
    GET "xx" -> boolean(3)
  `).then((res) => {
    console.log(res)
  })
}

window.basic = basic;
window.post = post;
window.httpHeaders = headers;
window.compose = compose;
window.wait = wait;
window.shapes = shapes
window.decorate = decorate;
window.fragment = fragment;
window.fns = fns;
window.mock = mock;
window.debug = debug;
window.normal = normal;

function apply() {
  const data = RestScript.apply(`
    DEFINE User: {
      id: string
      name: string
    }

    GET "" -> {
      user: &User
      time: number
    }
  `)
  console.log(data)
}

window.apply = apply

function ast() {
  const tokens = tokenize(`
    POST "https//api.bltcy.cn/recraft/v1/images/generations"
-H "Content-Type: application/json"
-H "Authorization: {BLTCY_API_KEY}"
-H "Accept: application/json"
+ {
    prompt: stirng;
    size?: string;
    style?: string;
    substyle?: string;
    response_format?: string;
    controls?: {
        colors: [{ rgb: <number, number, number> }];
        background_color?: string;
    }
}
-> {
    data: [{ url: string }]
} as Data

COMPOSE -> {
    data: (Data.data)
}
  `);
  const ast = parse(tokens);
  console.log(tokens);
  console.log(ast);
}

window.ast = ast;