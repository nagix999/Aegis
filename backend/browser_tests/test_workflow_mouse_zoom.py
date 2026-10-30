"""Pointer-centered canvas zoom with native wheel events on isolated demo data."""
from __future__ import annotations

from playwright.sync_api import expect

from test_switch_branching import close_panel, enter, open_editor, seed_workflow
from test_workflow_arrow_layout import condition_positions, save_positions


def prepare_canvas(page, console_server):
    page.set_viewport_size({'width': 1450, 'height': 900})
    enter(page, console_server)
    seed_workflow(page)
    save_positions(page, condition_positions({'x': 500, 'y': 350}, {'x': 1050, 'y': 350}))
    open_editor(page, console_server)
    close_panel(page)
    page.get_by_role('button', name='100% 보기', exact=True).click()
    settle(page)
    page.locator('.wc-viewport').evaluate('(element)=>{element.scrollLeft=120;element.scrollTop=300;}')
    return page.locator('.wc-viewport')


def settle(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')


def geometry(page, point=None):
    return page.evaluate("""point => {
      const viewport=document.querySelector('.wc-viewport'),box=viewport.getBoundingClientRect();
      const zoom=new DOMMatrix(getComputedStyle(document.querySelector('.wc-plane')).transform).a;
      const anchor=point??{x:box.left+viewport.clientLeft+viewport.clientWidth*.55,
        y:box.top+viewport.clientTop+viewport.clientHeight*.45};
      const world=document.querySelector('.wc-world');
      return {zoom,anchor,scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop,
        world:{x:(viewport.scrollLeft+anchor.x-box.left-viewport.clientLeft)/zoom-parseFloat(world.style.left),
          y:(viewport.scrollTop+anchor.y-box.top-viewport.clientTop)/zoom-parseFloat(world.style.top)},
        pageScale:visualViewport.scale};
    }""", point)


def modifier_wheel(page, point, delta, *, key='Control'):
    page.mouse.move(point['x'], point['y'])
    page.keyboard.down(key)
    try:
        page.mouse.wheel(0, delta)
        page.wait_for_timeout(80)
    finally:
        page.keyboard.up(key)
    settle(page)


def assert_same_world(before, after):
    assert abs(before['world']['x'] - after['world']['x']) < 2, (before, after)
    assert abs(before['world']['y'] - after['world']['y']) < 2, (before, after)


def test_ctrl_mouse_wheel_zooms_at_pointer_and_normal_wheel_still_scrolls(page, console_server):
    prepare_canvas(page, console_server)
    before = geometry(page)
    modifier_wheel(page, before['anchor'], -120)
    after = geometry(page, before['anchor'])
    assert after['zoom'] > before['zoom'], (before, after)
    assert_same_world(before, after)
    assert after['pageScale'] == before['pageScale'] == 1
    modifier_wheel(page, before['anchor'], 120)
    restored = geometry(page, before['anchor'])
    assert abs(restored['zoom'] - before['zoom']) < .00001
    assert_same_world(before, restored)
    page.mouse.wheel(0, 140)
    page.wait_for_timeout(100)
    scrolled = geometry(page, before['anchor'])
    assert scrolled['zoom'] == restored['zoom']
    assert scrolled['scrollTop'] > restored['scrollTop'] + 40


def test_meta_wheel_and_smooth_pinch_respect_pointer_and_zoom_limits(page, console_server):
    viewport = prepare_canvas(page, console_server)
    before = geometry(page)
    modifier_wheel(page, before['anchor'], -60, key='Meta')
    after = geometry(page, before['anchor'])
    assert after['zoom'] > before['zoom']
    assert_same_world(before, after)
    # Browser-delivered trackpad pinch uses fractional pixel deltas and Ctrl.
    smooth = viewport.evaluate("""point => {
      const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,
        deltaY:-.3,deltaMode:0,clientX:point.x,clientY:point.y});
      return {accepted:!document.querySelector('.wc-viewport').dispatchEvent(event),prevented:event.defaultPrevented};
    }""", before['anchor'])
    assert smooth == {'accepted': True, 'prevented': True}
    settle(page)
    pinched = geometry(page, before['anchor'])
    assert after['zoom'] < pinched['zoom'] < after['zoom'] + .002
    assert_same_world(after, pinched)
    modifier_wheel(page, before['anchor'], -1000)
    assert geometry(page)['zoom'] == 1.5
    modifier_wheel(page, before['anchor'], -1000)
    assert geometry(page)['zoom'] == 1.5
    for _ in range(5):
        modifier_wheel(page, before['anchor'], 1000)
    assert geometry(page)['zoom'] == .005
    page.get_by_role('button', name='100% 보기', exact=True).click()
    settle(page)
    assert geometry(page)['zoom'] == 1


def test_json_remount_cleans_listener_and_other_ui_keeps_its_wheel_behavior(page, console_server):
    prepare_canvas(page, console_server)
    before = geometry(page)
    page.evaluate("""() => {
      window.canvasWheelLifecycle={added:0,removed:0};
      const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener=function(type,listener,options){
        if(type==='wheel'&&this instanceof Element&&this.classList.contains('wc-viewport'))window.canvasWheelLifecycle.added++;
        return add.call(this,type,listener,options);
      };
      EventTarget.prototype.removeEventListener=function(type,listener,options){
        if(type==='wheel'&&this instanceof Element&&this.classList.contains('wc-viewport'))window.canvasWheelLifecycle.removed++;
        return remove.call(this,type,listener,options);
      };
    }""")
    page.get_by_role('button', name='JSON', exact=True).click()
    expect(page.locator('.wc-viewport')).to_have_count(0)
    assert page.evaluate('canvasWheelLifecycle.removed') == 1
    page.get_by_role('button', name='편집', exact=True).click()
    expect(page.locator('.wc-viewport')).to_be_visible()
    settle(page)
    assert page.evaluate('canvasWheelLifecycle.added') == 1
    after = geometry(page)
    assert after['zoom'] == before['zoom']
    modifier_wheel(page, after['anchor'], -100)
    once = geometry(page, after['anchor'])
    # A stale duplicate listener would apply the exponential step twice.
    assert abs(once['zoom'] / after['zoom'] - 1.1618342427) < .00001
    page.get_by_role('button', name='워크플로우 설정', exact=True).click()
    expect(page.locator('#workflow-node-inspector')).to_be_visible()
    textbox = page.locator('#workflow-node-inspector input').first
    expect(textbox).to_be_visible()
    consumed = textbox.evaluate("""element => {
      const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-100});
      element.dispatchEvent(event);return event.defaultPrevented;
    }""")
    assert consumed is False
    settle(page)
    assert geometry(page)['zoom'] == once['zoom']
