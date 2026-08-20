import handler from "vinext/server/app-router-entry";

const worker={async fetch(request:Request,env:unknown,ctx:unknown):Promise<Response>{return handler.fetch(request,env as never,ctx as never)}};
export default worker;

