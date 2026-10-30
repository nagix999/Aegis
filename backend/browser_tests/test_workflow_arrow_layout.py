"""Real canvas placement, port alignment and directed arrows on isolated demo data."""
from __future__ import annotations

import json

import pytest
from playwright.sync_api import expect

from test_switch_branching import (WORKFLOW_ID, close_panel, enter, open_editor,
                                   save_editor, seed_workflow)
from test_workflow_usability import (activate_policy_edge,
                                     expect_selected_route_in_panel,
                                     seed_shared_enum_switch)


def save_positions(page, positions):
    saved = page.evaluate("""async positions => {
      const state=(await(await fetch('/api/console')).json()).state;
      const workflow=state.workflows.find(item=>item.id==='wf-switch-browser');
      workflow.layout={version:1,positions,zones:[]};
      const response=await fetch('/api/console',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'save_workflow',workflow,expectedUpdatedAt:workflow.updatedAt})});
      return {status:response.status,body:await response.json()};
    }""", positions)
    assert saved['status'] == 200, saved['body']


def condition_positions(source, target):
    return {'input': {'x': 0, 'y': 850}, 'policy': {'x': 200, 'y': 850},
            'main': {'x': 1250, 'y': 850}, 'output': {'x': 1500, 'y': 850},
            'policy-node:fixture-condition': source,
            'policy-node:fixture-respond': target,
            'policy-node:fixture-error': {'x': 1000, 'y': 850}}


def show_canvas(page):
    close_panel(page)
    page.get_by_role('button', name='워크플로우 화면 넓게', exact=True).click()
    page.get_by_role('button', name='전체 보기', exact=True).click()
    page.wait_for_timeout(180)


def edge_geometry(page, edge_id):
    return page.evaluate("""edgeId => {
      const edge=document.querySelector(`g[data-policy-edge-id="${edgeId}"]`);
      const path=edge.querySelector('path.wc-edge'),length=path.getTotalLength(),matrix=path.getScreenCTM();
      const samples=Array.from({length:121},(_,index)=>{const point=path.getPointAtLength(length*index/120);return{x:point.x,y:point.y};});
      const from=edge.dataset.from.slice('policy-node:'.length),to=edge.dataset.to.slice('policy-node:'.length);
      const sourceGlyph=document.querySelector(`[data-policy-connect-port="${from}:${edge.dataset.port}"][data-port-side="${edge.dataset.sourceSide}"] span`);
      const targetGlyph=document.querySelector(`[data-policy-connect-target="${to}"][data-port-side="${edge.dataset.targetSide}"] span`);
      const center=glyph=>{if(!glyph)return null;const box=glyph.getBoundingClientRect();
        const point=new DOMPoint(box.x+box.width/2,box.y+box.height/2).matrixTransform(matrix.inverse());return{x:point.x,y:point.y};};
      return {sourceSide:edge.dataset.sourceSide,targetSide:edge.dataset.targetSide,d:path.getAttribute('d'),
        start:samples[0],end:samples.at(-1),samples,sourceGlyph:center(sourceGlyph),targetGlyph:center(targetGlyph),length};
    }""", edge_id)


def assert_port_alignment(geometry, *, source_glyph=True):
    if source_glyph:
        assert geometry['sourceGlyph'], geometry
        assert abs(geometry['start']['x'] - geometry['sourceGlyph']['x']) < 1.5, geometry
        assert abs(geometry['start']['y'] - geometry['sourceGlyph']['y']) < 1.5, geometry
    assert geometry['targetGlyph'], geometry
    offset = {'left': (-8, 0), 'right': (8, 0), 'top': (0, -8), 'bottom': (0, 8)}[geometry['targetSide']]
    assert abs(geometry['end']['x'] - geometry['targetGlyph']['x'] - offset[0]) < 1.5, geometry
    assert abs(geometry['end']['y'] - geometry['targetGlyph']['y'] - offset[1]) < 1.5, geometry


def assert_no_return_loop(geometry):
    assert ' C ' not in geometry['d'], geometry
    assert geometry['length'] > 0
    axis, sign = {'left': ('x', -1), 'right': ('x', 1), 'top': ('y', -1), 'bottom': ('y', 1)}[geometry['sourceSide']]
    # These deliberately unobstructed placements have no reason to reverse their
    # principal travel direction, even at rounded corners and branch ports.
    for previous, point in zip(geometry['samples'], geometry['samples'][1:]):
        assert (point[axis] - previous[axis]) * sign >= -.2, geometry
    start, end = geometry['start'], geometry['end']
    shortest = abs(start['x'] - end['x']) + abs(start['y'] - end['y'])
    assert geometry['length'] <= shortest + 2, geometry


@pytest.mark.parametrize('source,target,source_side,target_side', [
    ({'x': 400, 'y': 350}, {'x': 900, 'y': 350}, 'right', 'left'),
    ({'x': 900, 'y': 350}, {'x': 400, 'y': 350}, 'left', 'right'),
    ({'x': 650, 'y': 100}, {'x': 650, 'y': 550}, 'bottom', 'top'),
    ({'x': 650, 'y': 550}, {'x': 650, 'y': 100}, 'top', 'bottom'),
], ids=['right', 'left', 'down', 'up'])
def test_arrows_face_actual_node_placement_and_align_with_branch_ports(page, console_server, source, target, source_side, target_side, browser_artifact_dir):
    enter(page, console_server)
    seed_workflow(page)
    save_positions(page, condition_positions(source, target))
    open_editor(page, console_server)
    show_canvas(page)
    edge = page.locator('g[data-policy-edge-id="condition-yes"]')
    expect(edge).to_have_attribute('data-source-side', source_side)
    expect(edge).to_have_attribute('data-target-side', target_side)
    geometry = edge_geometry(page, 'condition-yes')
    assert_port_alignment(geometry)
    assert_no_return_loop(geometry)
    # The unused false output remains a separate, accurately placed port.
    false_edge = edge_geometry(page, 'condition-no')
    assert_port_alignment(false_edge)
    assert geometry['start'] != false_edge['start']
    (browser_artifact_dir / 'arrow-geometry.json').write_text(json.dumps(geometry), encoding='utf-8')


def test_actual_mouse_drag_reverses_arrow_while_preserving_pin_and_saved_positions(page, console_server):
    enter(page, console_server)
    seed_workflow(page)
    save_positions(page, condition_positions({'x': 500, 'y': 350}, {'x': 1050, 'y': 350}))
    open_editor(page, console_server, 'fixture-respond')
    page.locator('.we-inspector-head').get_by_role('button', name='자동 정렬에서 위치 고정', exact=True).click()
    node = page.locator('button[data-layout-key="policy-node:fixture-respond"]')
    expect(node).to_have_attribute('data-pinned', 'true')
    show_canvas(page)
    edge = page.locator('g[data-policy-edge-id="condition-yes"]')
    expect(edge).to_have_attribute('data-source-side', 'right')
    before = node.evaluate('(element)=>({x:parseFloat(element.style.left),y:parseFloat(element.style.top)})')
    box = node.bounding_box()
    assert box
    zoom = page.locator('.wc-plane').evaluate('(element)=>new DOMMatrix(getComputedStyle(element).transform).a')
    start_x, start_y = box['x'] + box['width'] / 2, box['y'] + 34 * zoom
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(start_x - 800 * zoom, start_y, steps=20)
    page.mouse.up()
    expect(edge).to_have_attribute('data-source-side', 'left')
    expect(edge).to_have_attribute('data-target-side', 'right')
    expect(node).to_have_attribute('data-pinned', 'true')
    after = node.evaluate('(element)=>({x:parseFloat(element.style.left),y:parseFloat(element.style.top)})')
    assert after['x'] < 500 < before['x'], {'before': before, 'after': after}
    geometry = edge_geometry(page, 'condition-yes')
    assert_port_alignment(geometry)
    assert_no_return_loop(geometry)
    saved = save_editor(page)
    assert saved['layout']['positions']['policy-node:fixture-respond'] == after
    assert 'policy-node:fixture-respond' in saved['layout']['pinnedKeys']


def test_reversed_shared_switch_routes_remain_individually_clickable(page, console_server):
    enter(page, console_server)
    seed_shared_enum_switch(page)
    positions = condition_positions({'x': 500, 'y': 350}, {'x': 400, 'y': 350})
    positions.pop('policy-node:fixture-condition')
    positions['policy-node:fixture-switch'] = {'x': 900, 'y': 350}
    save_positions(page, positions)
    open_editor(page, console_server, 'fixture-switch')
    show_canvas(page)
    paths = []
    for edge_id, port in [('shared-edge-1', 'case-1'), ('shared-edge-2', 'case-2')]:
        edge = page.locator(f'g[data-policy-edge-id="{edge_id}"]')
        expect(edge).to_have_attribute('data-source-side', 'left')
        expect(edge).to_have_attribute('data-target-side', 'right')
        geometry = edge_geometry(page, edge_id)
        assert_port_alignment(geometry, source_glyph=False)
        paths.append(geometry['d'])
        activate_policy_edge(page, edge_id)
        expect_selected_route_in_panel(page, edge_id)
        expect(page.locator(f'[data-policy-route-port="{port}"]')).to_have_attribute('data-policy-selected-edge', edge_id)
        close_panel(page)
    assert paths[0] != paths[1]
