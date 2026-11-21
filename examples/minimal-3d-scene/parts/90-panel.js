import Panel from './Panel.svelte'
export default (ctx) => { ctx.mount(Panel, { state: ctx.state, dispatch: ctx.dispatch }) }
