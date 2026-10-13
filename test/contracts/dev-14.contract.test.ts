/**
 * Named pending contracts for DEV-14 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-14 pending contracts', () => {
  it.todo('O24 (DEV-14): Agent tools (`octo_management`: 24 enum actions including write-secret; separate advertised message actions: send/read/search)');
  it.todo('EP-12 (DEV-14): groups list/get');
  it.todo('EP-15 (DEV-14): group md GET/PUT');
  it.todo('EP-16 (DEV-14): thread md GET/PUT');
  it.todo('EP-17 (DEV-14): group info/create/members add/remove');
  it.todo('EP-18 (DEV-14): threads create/list/get/delete/members/join/leave');
  it.todo('EP-20 (DEV-14): space/members, resolve/targets');
  it.todo('EP-12.list (DEV-14): groups list/get — list');
  it.todo('EP-12.get (DEV-14): groups list/get — get');
  it.todo('EP-15.PUT (DEV-14): group md GET/PUT — PUT');
  it.todo('EP-16.PUT (DEV-14): thread md GET/PUT — PUT');
  it.todo('EP-17.info (DEV-14): group info/create/members add/remove — info');
  it.todo('EP-17.create (DEV-14): group info/create/members add/remove — create');
  it.todo('EP-17.members.add (DEV-14): group info/create/members add/remove — members.add');
  it.todo('EP-17.members.remove (DEV-14): group info/create/members add/remove — members.remove');
  it.todo('EP-18.create (DEV-14): threads create/list/get/delete/members/join/leave — create');
  it.todo('EP-18.list (DEV-14): threads create/list/get/delete/members/join/leave — list');
  it.todo('EP-18.get (DEV-14): threads create/list/get/delete/members/join/leave — get');
  it.todo('EP-18.delete (DEV-14): threads create/list/get/delete/members/join/leave — delete');
  it.todo('EP-18.members (DEV-14): threads create/list/get/delete/members/join/leave — members');
  it.todo('EP-18.join (DEV-14): threads create/list/get/delete/members/join/leave — join');
  it.todo('EP-18.leave (DEV-14): threads create/list/get/delete/members/join/leave — leave');
  it.todo('EP-20.space-members (DEV-14): space/members, resolve/targets — space-members');
  it.todo('EP-20.resolve-targets (DEV-14): space/members, resolve/targets — resolve-targets');
  it.todo('O24.mgmt.list-groups (DEV-14): octo_management action list-groups');
  it.todo('O24.mgmt.group-info (DEV-14): octo_management action group-info');
  it.todo('O24.mgmt.group-members (DEV-14): octo_management action group-members');
  it.todo('O24.mgmt.group-md-read (DEV-14): octo_management action group-md-read');
  it.todo('O24.mgmt.group-md-update (DEV-14): octo_management action group-md-update');
  it.todo('O24.mgmt.search-members (DEV-14): octo_management action search-members');
  it.todo('O24.mgmt.resolve (DEV-14): octo_management action resolve');
  it.todo('O24.mgmt.create-group (DEV-14): octo_management action create-group');
  it.todo('O24.mgmt.update-group (DEV-14): octo_management action update-group');
  it.todo('O24.mgmt.add-members (DEV-14): octo_management action add-members');
  it.todo('O24.mgmt.remove-members (DEV-14): octo_management action remove-members');
  it.todo('O24.mgmt.create-thread (DEV-14): octo_management action create-thread');
  it.todo('O24.mgmt.list-threads (DEV-14): octo_management action list-threads');
  it.todo('O24.mgmt.get-thread (DEV-14): octo_management action get-thread');
  it.todo('O24.mgmt.delete-thread (DEV-14): octo_management action delete-thread');
  it.todo('O24.mgmt.list-thread-members (DEV-14): octo_management action list-thread-members');
  it.todo('O24.mgmt.join-thread (DEV-14): octo_management action join-thread');
  it.todo('O24.mgmt.leave-thread (DEV-14): octo_management action leave-thread');
  it.todo('O24.mgmt.thread-md-read (DEV-14): octo_management action thread-md-read');
  it.todo('O24.mgmt.thread-md-update (DEV-14): octo_management action thread-md-update');
  it.todo('O24.msg.send (DEV-14): message tool action send (separate from octo_management)');
  it.todo('O24.msg.read (DEV-14): message tool action read (separate from octo_management)');
  it.todo('O24.msg.search (DEV-14): message tool action search (separate from octo_management)');
});
