/* eslint-disable no-labels */
/* eslint-disable no-continue */
/* eslint-disable no-underscore-dangle */
/*
 * The module to handle greenstand map
 */
import 'leaflet';

import axios from 'axios';
import expect from 'expect-runtime';
import log from 'loglevel';

class MapModel {
  constructor(options) {
    expect(options).property('apiUrl').defined();
    this.apiUrl = options.apiUrl;
    expect(options).property('onShowArrow').a(expect.any(Function));
    expect(options).property('onHideArrow').a(expect.any(Function));
    this._onShowArrow = options.onShowArrow;
    this._onHideArrow = options.onHideArrow;
    this._markers = [];
    this._map = undefined;
    this._cancelAxios = undefined;
  }

  set markers(mks) {
    this._markers = mks;
  }

  get markers() {
    return this._markers;
  }

  set map(map) {
    this._map = map;
  }

  get map() {
    return this._map;
  }

  /*
   * To check if need display arrow
   */
  async checkArrow() {
    log.log('check arrow');
    const mymap = this._map;
    const utfGridLayer = Object.values(mymap._layers).reduce(
      (a, c) => (c._url && c._url.match(/grid.json$/) ? c : a),
      undefined,
    );
    const { x, y } = mymap.getSize();

    let found = false;

    // check zoom level
    log.warn('zoom level:', mymap.getZoom());
    //    expect(utfGridLayer).property("options").property("minZoom").defined();
    if (
      utfGridLayer === undefined ||
      mymap.getZoom() > utfGridLayer.options.maxZoom ||
      mymap.getZoom() < utfGridLayer.options.minZoom
    ) {
      log.warn('no utf or out of utf layer range, use old way');
      if (
        // no markers
        this._markers.length === 0 ||
        // all markers out of bounds
        this._markers.every(
          (marker) => !this._map.getBounds().contains(marker.getLatlon()),
        )
      ) {
        found = false;
      } else {
        found = true;
      }
    } else {
      log.warn('utf calculating');

      // waiting layer is ready
      const isLoading = utfGridLayer.isLoading();
      log.warn('utf layer is loading:', isLoading);
      if (isLoading) {
        log.error('can not handle the grid utif check, cancel!');
        return;
      }

      const begin = Date.now();
      let count = 0;
      let countNoChar = 0;
      // eslint-disable-next-line no-restricted-syntax
      me: for (let y1 = 0; y1 < y; y1 += 10) {
        for (let x1 = 0; x1 < x; x1 += 10) {
          count += 1;
          const tileChar = utfGridLayer._objectForEvent({
            latlon: mymap.containerPointToLatlon([x1, y1]),
          })._tileCharCode;
          if (!tileChar) {
            countNoChar += 1;
            // log.warn("can not fond char on!:", x1, y1);
            continue;
          }
          const m = tileChar.match(/\d+:\d+:\d+:(\d+)/);
          if (!m) throw new Error(`Wrong char:${tileChar}`);
          if (m[1] !== '32') {
            log.log('find:', tileChar, 'at:', x1, y1);
            found = true;
            break me;
          }
        }
      }
      log.warn(
        'Take time:%d, count:%d,%d,found:%s',
        Date.now() - begin,
        count,
        countNoChar,
        found,
      );
    }
    if (!found) {
      // no markers, need to find nearest
      const center = this._map.getCenter();
      const nearest = await this.getNearest();
      if (nearest) {
        // find it
        // get nearest markers
        expect(nearest.lat).number();
        expect(nearest.lon).number();
        if (
          !this._map.getBounds().contains({
            lat: nearest.lat,
            lon: nearest.lon,
          })
        ) {
          log.log('out of bounds, display arrow');
          const dist = {
            lat: nearest.lat,
            lon: nearest.lon,
          };
          const distanceLat = window.L.CRS.EPSG3857.distance(
            center,
            window.L.latlon(dist.lat, center.lon),
          );
          log.log('distanceLat:', distanceLat);
          expect(distanceLat).number();
          const distancelon = window.L.CRS.EPSG3857.distance(
            center,
            window.L.latlon(center.lat, dist.lon),
          );
          log.log('distancelon:', distancelon);
          expect(distancelon).number();
          log.log('dist:', dist);
          log.log('center:', center, center.lat);
          if (dist.lat > center.lat) {
            log.log('On the north');
            if (distanceLat > distancelon) {
              log.log('On the north');
              this.showArrow('north');
            } else if (dist.lon > center.lon) {
              log.log('On the east');
              this.showArrow('east');
            } else {
              log.log('On the west');
              this.showArrow('west');
            }
          } else {
            log.log('On the south');
            if (distanceLat > distancelon) {
              log.log('On the south');
              this.showArrow('south');
            } else if (dist.lon > center.lon) {
              log.log('On the east');
              this.showArrow('east');
            } else {
              log.log('On the west');
              this.showArrow('west');
            }
          }
        } else {
          this.hideArrow();
        }
      }
    } else {
      this.hideArrow();
    }
  }

  /*
   * To show/hide the arrow icon on the map
   */
  hideArrow() {
    this._onHideArrow();
    //    const arrow = $("#arrow");
    //    arrow.hide();
  }

  showArrow(direction) {
    //    const arrow = $("#arrow");
    this._onShowArrow(direction);
    //    if(direction === "north"){
    //      arrow.removeClass();
    //      arrow.addClass("north");
    //    }else if(direction === "south"){
    //      arrow.removeClass();
    //      arrow.addClass("south");
    //    }else if(direction === "west"){
    //      arrow.removeClass();
    //      arrow.addClass("west");
    //    }else if(direction === "east"){
    //      arrow.removeClass();
    //      arrow.addClass("east");
    //    }
    //    arrow.show();
  }

  /*
   * pan map to nearest point
   */
  async gotoNearest() {
    this.hideArrow();
    const nearest = await this.getNearest();
    if (nearest) {
      this._map.panTo(nearest);
    }
  }

  async getNearest() {
    // try to cancel previous request if any
    // await this._source.cancel("cancel prevous nearest request");
    if (this._cancelAxios) {
      log.log('cancel');
      this._cancelAxios('cancel previous nearest request');
    }
    const center = this._map.getCenter();
    log.log('current center:', center);
    const zoom_level = this._map.getZoom();
    const res = await axios.get(
      `${this.apiUrl}nearest?zoom_level=${zoom_level}&lat=${center.lat}&lon=${center.lon}`,
      {
        cancelToken: new axios.CancelToken((c) => {
          this._cancelAxios = c;
        }),
      },
    );
    this._cancelAxios = undefined;
    if (res.status !== 200) {
      throw Error('request failed');
    }
    let { nearest } = res.data;
    nearest = nearest
      ? {
          lat: nearest.coordinates[1],
          lon: nearest.coordinates[0],
        }
      : undefined;
    log.log('get nearest:', nearest);
    return nearest;
  }
}

export default MapModel;
