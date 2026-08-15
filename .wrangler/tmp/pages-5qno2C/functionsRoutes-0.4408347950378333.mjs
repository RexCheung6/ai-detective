import { onRequest as __api_accuse_js_onRequest } from "/Users/rc/project/new/ai-detective/functions/api/accuse.js"
import { onRequest as __api_case_js_onRequest } from "/Users/rc/project/new/ai-detective/functions/api/case.js"
import { onRequest as __api_cases_js_onRequest } from "/Users/rc/project/new/ai-detective/functions/api/cases.js"
import { onRequest as __api_chat_js_onRequest } from "/Users/rc/project/new/ai-detective/functions/api/chat.js"
import { onRequest as __api_chat_result_js_onRequest } from "/Users/rc/project/new/ai-detective/functions/api/chat-result.js"

export const routes = [
    {
      routePath: "/api/accuse",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_accuse_js_onRequest],
    },
  {
      routePath: "/api/case",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_case_js_onRequest],
    },
  {
      routePath: "/api/cases",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_cases_js_onRequest],
    },
  {
      routePath: "/api/chat",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_chat_js_onRequest],
    },
  {
      routePath: "/api/chat-result",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api_chat_result_js_onRequest],
    },
  ]