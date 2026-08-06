/**
 * WebSocket 帧解析器
 * 基于 mk48 源码逆向 bitcode 编码格式
 * 
 * mk48 Update 结构 (Server→Client):
 * - contacts: Vec<Contact>
 * - death_reason: Option<DeathReason>
 * - score: u32
 * - world_radius: f32
 * - terrain: [(ChunkId, SerializedChunk)]
 * - team: Vec<TeamUpdate>
 * 
 * Contact 结构:
 * - transform: { position: Vec2, velocity: f32, direction: f32 }
 * - altitude: i8
 * - entity_type: Option<EntityType> (varint index)
 * - guidance: { direction_target: f32, velocity_target: f32 }
 * - id: EntityId (u32)
 * - player_id: Option<PlayerId>
 * - reloads: BitArray<u32>
 * - turrets: Vec<Angle>
 */

class WsFrameParser {
  constructor() {
    this.frameCount = 0;
    this.parseErrors = 0;
    this.lastUpdate = null;
    this.callbacks = { onUpdate: null, onCommand: null };
  }

  on(event, cb) { this.callbacks['on' + event.charAt(0).toUpperCase() + event.slice(1)] = cb; }

  /**
   * 解析 Server→Client 二进制帧
   */
  parseServerFrame(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    this.frameCount++;

    const result = {
      frame: this.frameCount,
      ts: Date.now(),
      size: buffer.length,
      contacts: [],
      score: null,
      worldRadius: null,
      deathReason: null,
      terrainChunks: [],
      teamUpdates: []
    };

    try {
      let offset = 0;

      // 1. 读取 contacts 数量 (varint)
      const contactsCount = this.readVarint(buffer, offset);
      if (contactsCount === null) return result;
      offset = contactsCount.offset;
      result.contactsCount = contactsCount.value;

      // 2. 逐个解析 contact
      for (let i = 0; i < Math.min(contactsCount.value, 200); i++) {
        if (offset + 24 > buffer.length) break;

        const contact = this.parseContact(buffer, offset);
        if (!contact) break;
        result.contacts.push(contact.data);
        offset = contact.offset;
      }

      // 3. 尝试解析 death_reason (Option<DeathReason>)
      if (offset < buffer.length) {
        const hasDeath = buffer[offset++];
        if (hasDeath && offset < buffer.length) {
          result.deathReason = { type: 'death', reason: buffer[offset++] };
        }
      }

      // 4. 解析 score (u32)
      if (offset + 4 <= buffer.length) {
        result.score = buffer.readUInt32LE(offset);
        offset += 4;
      }

      // 5. 解析 world_radius (f32)
      if (offset + 4 <= buffer.length) {
        result.worldRadius = buffer.readFloatLE(offset);
        offset += 4;
      }

      // 6. 解析 terrain (简化：跳过)
      if (offset < buffer.length) {
        const terrainCount = this.readVarint(buffer, offset);
        if (terrainCount) {
          offset = terrainCount.offset;
          // 跳过 terrain chunks
          for (let i = 0; i < Math.min(terrainCount.value, 50); i++) {
            // ChunkId: u64
            if (offset + 8 > buffer.length) break;
            const chunkId = buffer.readBigUInt64LE(offset);
            offset += 8;
            // SerializedChunk: 长度前缀 + 数据
            const chunkLen = this.readVarint(buffer, offset);
            if (!chunkLen) break;
            offset = chunkLen.offset;
            const len = chunkLen.value;
            if (offset + len > buffer.length) break;
            result.terrainChunks.push({ id: chunkId.toString(), size: len });
            offset += len;
          }
        }
      }

    } catch (e) {
      this.parseErrors++;
    }

    this.lastUpdate = result;
    if (this.callbacks.onUpdate) this.callbacks.onUpdate(result);
    return result;
  }

  /**
   * 解析单个 Contact
   */
  parseContact(buffer, offset) {
    try {
      let pos = offset;
      const view = new DataView(buffer.buffer, buffer.byteOffset + pos, buffer.byteLength - pos);
      let vPos = 0;

      // entityId: u32 (4 bytes)
      const entityId = view.getUint32(vPos, true);
      vPos += 4;
      if (entityId === 0 || entityId > 0xFFFFFF) return null;

      // position: Vec2 = (f32, f32)
      const posX = view.getFloat32(vPos, true);
      const posY = view.getFloat32(vPos + 4, true);
      vPos += 8;
      if (Math.abs(posX) > 50000 || Math.abs(posY) > 50000 || isNaN(posX) || isNaN(posY)) return null;

      // velocity: f32
      const velocity = view.getFloat32(vPos, true);
      vPos += 4;
      if (isNaN(velocity) || Math.abs(velocity) > 100) return null;

      // direction: f32
      const direction = view.getFloat32(vPos, true);
      vPos += 4;
      if (isNaN(direction) || Math.abs(direction) > 10) return null;

      // altitude: i8
      const altitude = buffer[pos + vPos];
      vPos++;

      // entity_type: Option<EntityType> (varint)
      const hasType = buffer[pos + vPos];
      vPos++;
      let entityType = null;
      if (hasType && pos + vPos < buffer.length) {
        const typeIdx = this.readVarint(buffer, pos + vPos);
        if (typeIdx) {
          entityType = this.entityTypeFromIndex(typeIdx.value);
          vPos = typeIdx.offset - pos;
        }
      }

      return {
        offset: pos + vPos,
        data: {
          id: entityId,
          pos: { x: posX, y: posY },
          velocity,
          direction,
          altitude,
          entityType,
          speed: Math.abs(velocity),
          submerged: altitude < 0
        }
      };
    } catch {
      return null;
    }
  }

  /**
   * 解析 Client→Server Command 帧
   */
  parseClientFrame(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

    const result = { ts: Date.now(), size: buffer.length, type: 'unknown', data: {} };

    try {
      if (buffer.length === 0) return result;

      // Command enum tag
      const tag = buffer[0];
      switch (tag) {
        case 0: { // Control
          result.type = 'control';
          let offset = 1;

          // guidance: Option<Guidance>
          if (offset < buffer.length && buffer[offset++]) {
            if (offset + 8 <= buffer.length) {
              result.data.guidance = {
                direction: buffer.readFloatLE(offset),
                velocity: buffer.readFloatLE(offset + 4)
              };
              offset += 8;
            }
          }

          // submerge: bool
          if (offset < buffer.length) result.data.submerge = !!buffer[offset++];

          // aim_target: Option<Vec2>
          if (offset < buffer.length && buffer[offset++]) {
            if (offset + 8 <= buffer.length) {
              result.data.aimTarget = {
                x: buffer.readFloatLE(offset),
                y: buffer.readFloatLE(offset + 4)
              };
              offset += 8;
            }
          }

          // active: bool
          if (offset < buffer.length) result.data.active = !!buffer[offset++];

          // fire: Option<Fire>
          if (offset < buffer.length && buffer[offset++]) {
            if (offset < buffer.length) {
              result.data.fire = { armamentIndex: buffer[offset++] };
            }
          }
          break;
        }
        case 1: { // Spawn
          result.type = 'spawn';
          let offset = 1;
          if (offset < buffer.length && buffer[offset++]) {
            const aliasLen = buffer[offset++];
            if (offset + aliasLen <= buffer.length) {
              result.data.alias = buffer.slice(offset, offset + aliasLen).toString('utf-8');
              offset += aliasLen;
            }
          }
          if (offset < buffer.length) {
            const typeLen = buffer[offset++];
            if (offset + typeLen <= buffer.length) {
              result.data.entityType = buffer.slice(offset, offset + typeLen).toString('utf-8');
            }
          }
          break;
        }
        case 2: result.type = 'upgrade'; break;
        case 3: result.type = 'team'; break;
      }
    } catch { this.parseErrors++; }

    if (this.callbacks.onCommand) this.callbacks.onCommand(result);
    return result;
  }

  readVarint(buffer, offset) {
    if (offset >= buffer.length) return null;
    let value = 0, shift = 0, pos = offset;
    while (pos < buffer.length && pos < offset + 5) {
      const byte = buffer[pos++];
      value |= (byte & 0x7F) << shift;
      if ((byte & 0x80) === 0) return { value, offset: pos };
      shift += 7;
    }
    return { value, offset: pos };
  }

  entityTypeFromIndex(idx) {
    // mk48 实体类型索引 (部分)
    const types = [
      'Barrel','Dhow','Kayak','Fisher','Sloop','Brigantine','Cutter',
      'Barque','Clipper','Xebec','Corvette','Schooner','Pinnace',
      'Frigate','Destroyer','Cruiser','Battleship','Battlecruiser',
      'Dreadnought','Carrier','Submarine','AttackSubmarine','OilPlatform'
    ];
    return types[idx] || `Entity_${idx}`;
  }

  getStats() {
    return {
      frameCount: this.frameCount,
      parseErrors: this.parseErrors,
      lastUpdateSize: this.lastUpdate?.size || 0,
      lastContacts: this.lastUpdate?.contacts?.length || 0
    };
  }
}

module.exports = { WsFrameParser };
