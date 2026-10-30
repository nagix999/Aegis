"""Observe the UI's real NDJSON fetch with a bounded wait, without CDP caching."""
import json


def observe_playground(page):
    page.evaluate('''() => {
      window.__aegisObservedPlayground={done:false};
      if(window.__aegisPlaygroundObserverInstalled)return;
      window.__aegisPlaygroundObserverInstalled=true;
      const original=window.fetch;
      window.fetch=async (...args)=>{
        const response=await original(...args);
        if(args[1]?.body && JSON.parse(args[1].body).action==='playground'){
          const observed=window.__aegisObservedPlayground;
          response.clone().text().then(body=>Object.assign(observed,{done:true,body}),
            error=>Object.assign(observed,{done:true,error:String(error)}));
        }
        return response;
      };
    }''')


def playground_events(page):
    page.wait_for_function('window.__aegisObservedPlayground?.done===true', timeout=12000)
    observed=page.evaluate('window.__aegisObservedPlayground')
    assert not observed.get('error'), observed
    return [json.loads(line) for line in observed['body'].splitlines() if line.strip()]
