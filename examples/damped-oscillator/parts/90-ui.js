import App from './App.svelte'
export default (ctx) => { ctx.mount(App, { state: ctx.state }) }
