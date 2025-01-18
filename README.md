# entsoe-js
This is external module for openHAB automation.

The main function:

* getSpotAndAvgPrices(user_period_start, user_period_end, fill_missing_values=1)

The secondary functions:

* getSpotPrices(user_period_start, user_period_end);
* fillEmptyHours(user_period);

## Pre-requirements

* Install **XSLT transformation** in web-gui openHAB;
* Download **xml2json.xsl** file and put into following location: /etc/openhab/transform <br> The original file located [here](https://xml2json.duttke.de/) (Last visited 2025-01)


## Usage

Into web-gui openHAB create JS script:

```
var SpotPriceFin = new entsoe_tp.Entsoe(ENTSOE_API_TOKEN, "your_country", tax, rounding_precision, cnt_kWh=1);

var [prices, avg_month] = SpotPriceFin.getSpotAndAvgPrices(day_avg_start, day_avg_end, fill_missing_values=1);

```
In case response is received, the **price** will contain:

```
@prices = {
 *		"yyyy-MM-dd" : [ {"time": "HH:mm", "price": float_value},
 *				 {"time": "HH:mm", "price": float_value},
 *				 .... ],
 *		"yyyy-MM-dd" : [ {"time": "HH:mm", "price": float_value},
 *				 {"time": "HH:mm", "price": float_value},
 *				 .... ],
```

The **avg_month** will contain average value for [day_avg_start, day_avg_end]


* the variable **cnt_kWh=1** - by default return price cnt/kWh, if this value set to 0, the price will be Euro/MWh (or other currency)
* the variable **fill_missing_values=1** for some day Entsoe may return not 24 item (time/price) for resolution PT60M. in this case there is software restore (the function *fillEmptyHours*) missing time/price items. At this moment during restore process - it just take prvious value from hour. If missing value for "00:00" - the value "0" will be set.