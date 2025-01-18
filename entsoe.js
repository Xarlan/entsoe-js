var HTTP             = Java.type("org.openhab.core.model.script.actions.HTTP");
var TRANSFORMATION   = Java.type("org.openhab.core.transform.actions.Transformation");

/*
 * This file (xml2json.xsl) used to make transofrmation from XML 2 JSON
 * Was downloaded from https://xml2json.duttke.de/ 2024-04-15
 * Also need install addons 'XSLT Transformation' and copy this file to /etc/openhab/transform
*/
var STYLESHEET          = "xml2json.xsl"
var TIMEOUT             = 10000  // value in ms

var ENTSOE_TIME_PATTERN = "yyyyMMddHHmm"
var BASE_URL            = "https://web-api.tp.entsoe.eu/api?"

/*
 * A.9. DocumentType:
 * https://transparency.entsoe.eu/content/static_content/Static%20content/web%20api/Guide.html#_documenttype
 *
 * For new version of docummentation (since 2025-01-01)
 * GET request to price is described in section 'GET 12.1.D Energy Prices'
*/
var DOCUMENT_TYPE    = "A44"

class Entsoe {

    constructor(api_token, country, tax, rounding_precision=2, cnt_kWh=1) {
        this.config = require('entsoe/config.js');
	this.area = null;
	this.tax = null;
	this.api_token = null;
	this.cnt_kWh = cnt_kWh;				// "1" - return price cnt/kWh
							// "0" - return price Euro/MWh
	this.rounding_precision = rounding_precision;
	this.user_time_begin = null;
	this.user_time_end   = null;
	this.property = {};				// This variable will be contain:
							// {
  							//      "yyyy-mm-dd": {
    							//          "currency": "EUR",
    							//          "unit": "MWH",
    							//	    "resolution": "PT60M"
  							//      },
							//  ...
							// }

	if (this.config.country[country]) {
    	    this.area = this.config.country[country];
	    this.tax = tax;
	    this.api_token = api_token;
	    console.info("Selected country   :", country);
	    console.info("Tax for electricity: %d%", this.tax);
	} else {
	    var err_msg = "This country '" + country + "' is not presented in Entsoe\n";
		err_msg += "Try to find your country here: https://www.entsoe.eu/data/energy-identification-codes-eic/eic-approved-codes/";
	    throw new Error(err_msg);
	}
    }  // end constructor


/*
 * Get Spot price and average for selected period
 * [intput]
 *	@user_period_start - start Date;
 *	@user_period_end   - end Date;
 *	@fill_missing_values - for Period -> resolution -> PT60 
 *			       should be 24 value (time/price) for 24 hour [00.00 ... 23.00]
 *			     == 1 use software calculation to restore missing valu
 *			     == 0 provide [hourly_cost, avg] with missing value
 * [output]
 *	[hourly_cost, avg]
*/
    getSpotAndAvgPrices(user_period_start, user_period_end, fill_missing_values=1) {
	var total_sum = 0;
	var total_count = 0;

	if ( this.validate_time_arguments(user_period_start, user_period_end) ) {
		var period_start = new Date(user_period_start);
		var period_end   = new Date(user_period_end);
	} else {
		return [null, null];
	}


	var [hourly_cost, qitem] = this.getSpotPrices(period_start, period_end);

	if (hourly_cost == null) {
		return [null, null];
	}

	var total_items = 24 * Math.ceil((user_period_end.getTime() - user_period_start.getTime()) / (1000 * 3600 * 24));

	if ( qitem != total_items && fill_missing_values == 1 ) {
		console.warn(`To calculate avg need ${total_items} items; Entsoe send ${qitem} items`);
		hourly_cost = this.fillEmptyHours(hourly_cost);
	}

	for (var current_day in hourly_cost) {
	    for (var index in hourly_cost[current_day]) {
		total_sum += hourly_cost[current_day][index]["price"];
	    }
	    total_count += hourly_cost[current_day].length;
	}

	console.info("[entsoe.js] -> Avg price is: ", (total_sum/total_count).toFixed(this.rounding_precision));

	this.user_time_begin = null;
        this.user_time_end   = null;
        this.property = {};

	return [hourly_cost, total_sum/total_count];
    }   // end func [getSpotAndAvgPrices]


/*
 * Check that user input of date is correct
*/
    validate_time_arguments(user_period_start, user_period_end) {
	if ( !(user_period_start instanceof Date) ) {
		console.error("[entsoe.js] -> 'Start period' is not a Date object: ", user_period_start);
		return false;
	}

	if ( !(user_period_end instanceof Date) ) {
		console.error("[entsoe.js] -> 'End period' is not a Date object: ", user_period_end);
		return false;
	}

	if (user_period_end < user_period_start) {
        	console.error("'period End' [%s] can't be before 'period Start' [%s]",
				user_period_end.toLocaleDateString() + " " + user_period_end.toLocaleTimeString(),
				user_period_start.toLocaleDateString() + " " + user_period_start.toLocaleTimeString())
		return false;
    	} else {
		this.user_time_begin = new Date(user_period_start);
		this.user_time_end   = new Date(user_period_end);
		console.info("User period start: ", this.user_time_begin);
		console.info("     period end:   ", this.user_time_end);
		return true;
	}
    }  // end func [validate_time_argiment]

/*
 * [Input]
 * 	@user_period_start - object 'Date'
 *	@user_period_end   - object 'Date'
 *
 * [Output]
 *	@[prices, qitem]
 *	@prices = {
 *		"yyyy-MM-dd" : [ {"time": "HH:mm", "price": float_value},
 *				 {"time": "HH:mm", "price": float_value},
 *				 .... ],
 *		"yyyy-MM-dd" : [ {"time": "HH:mm", "price": float_value},
 *				 {"time": "HH:mm", "price": float_value},
 *				 .... ],
 *	@qitem - how many elemets time/price are in the @prices
 *		 Sometime Entsoe may return not 24 item per 24 hours
 *		 i.e. some hours (time/price) maybe missed.
 *		 To fix this, possible call function 'fill_empty_hours'
*/
   getSpotPrices(user_period_start, user_period_end) {
	var response = null;
	var hourly_cost = null;
	var entsoe_time_interval = null;

	if (this.user_time_begin == null && this.user_time_end == null) {

		if ( this.validate_time_arguments(user_period_start, user_period_end) ) {
			var period_start = new Date(user_period_start);
			var period_end   = new Date(user_period_end);
		} else {
			return [null, null];
		}
	} else {
		var period_start = new Date(user_period_start);
                var period_end   = new Date(user_period_end);
	}

	/*
	 * Subtract 24 hours to get price for period [00.00 - 01.00] of requested interval
	 * This happen because entsoe api return price for period [1 ... 24], where
	 *   (1) - it is relevant for current day [1.00 ... 2.00]
	 *   (24) - it is relevant for (current day + 1) [0.00 ... 1.00]
         */
	period_start.setDate(period_start.getDate() - 1);

	entsoe_time_interval = [this.transform_date_to_entsoe_format(period_start),
		                this.transform_date_to_entsoe_format(period_end)];

	response = this.http_get_request(entsoe_time_interval[0], entsoe_time_interval[1]);

	if ( response ) {
		hourly_cost = this.parse_entsoe_response(response);
	} else {
		console.warn("[entsoe.js]-> There is no response from Entsoe");
		return [null, null];
	}

	if (hourly_cost !== null) {
	    console.info("getSpotPrice completed successfully. Price data has been successfully retrieved");
	    return [this.group_by_days(hourly_cost), Object.keys(hourly_cost).length];
	} else {
	    console.error("Can't receive prices from Entsoe");
	    return [null, null];
	}
   }	// end func [getSpotPrice]


/*
 * For some date Entsoe may return not 24 item "time/price" for 24 hours (resolution PT60M)
 * I.e. it mean that for some hour the combination "time/price" will be missed.
 * Usually it happen when the same price presented on next hour.
 * So, if we received @user_period where missed for example item "time/price" for "03:00" hour
 * the missing value will be restored from previous hour or if missed value for "00:00"
 * in this case the item "time/price" will be "00:00" : 0
*/
    fillEmptyHours(user_period) {
	var all_hours = [...Array(24).keys()];
	var unit_price = (this.cnt_kWh == 1) ? "cnt/kWh" : "Euro/MWh";

	for (var current_day in user_period) {
       	    if (user_period[current_day].length != 24) {
            	var received_hours = user_period[current_day].map(entry => parseInt(entry.time.slice(0,2)));
            	var received_hours_set = new Set(received_hours);
            	var missing_hours = all_hours.filter(hour => !received_hours_set.has(hour))

            	for (var add_hour of missing_hours) {
            	    var soft_price = user_period[current_day][add_hour-1]?.price ?? 0;
                    var soft_time = add_hour.toString().padStart(2, '0') + ":00"
                    console.warn(`On ${current_day} at ${soft_time}, the electricity price was software calculated as ${soft_price} ${unit_price}`);
                    user_period[current_day].splice(add_hour, 0, {"time": soft_time, "price":soft_price})
                }
            }  // close if (user_period[current_day].length != 24)
        } // close for (current_day in user_period) {

	return user_period;
    }   // end func [fill_empty_hours]


/*
 * Transform object type 'Date' to string with specific format: "yyyyMMddHHmm"
 * This transformation is step for preparation API request to Entsoe
*/
   transform_date_to_entsoe_format(raw_date) {
	var entsoe_year    = raw_date.getFullYear();
	var entsoe_month   = (raw_date.getMonth() + 1).toString().padStart(2, '0');  // Month is 0-based
	var entsoe_day     = raw_date.getDate().toString().padStart(2, '0');
	var entsoe_hours   = raw_date.getHours().toString().padStart(2, '0');
	var entsoe_minutes = raw_date.getMinutes().toString().padStart(2, '0');

   	return `${entsoe_year}${entsoe_month}${entsoe_day}${entsoe_hours}${entsoe_minutes}`;
   }

   http_get_request(time_start, time_end) {
	var raw_xml = null;
	var url_request = BASE_URL;

	url_request = url_request.concat("securityToken=", this.api_token);
	url_request = url_request.concat("&documentType=", DOCUMENT_TYPE);
	url_request = url_request.concat("&in_domain=", this.area);
	url_request = url_request.concat("&out_domain=", this.area);
	url_request = url_request.concat("&periodStart=", time_start);
	url_request = url_request.concat("&periodEnd=", time_end);

	console.info("GET request: ", url_request);
	raw_xml = HTTP.sendHttpGetRequest(url_request, TIMEOUT);

	return raw_xml;
   }    // end func [http_get_request]


   parse_entsoe_response(raw_xml_response) {
	var json_response = [];
	var price_for_every_hour = [];

	try {
            json_response = JSON.parse(TRANSFORMATION.transform('XSLT', STYLESHEET, raw_xml_response));
	} catch (exception) {
            console.error(raw_xml_response);
	    console.error("Error while transforming XML to JSON");
            console.error("Pre requirements:");
            console.error("    - install addons 'XSLT Transformation'");
            console.error("    - download 'xml2json.xls' file from https://xml2json.duttke.de");
	    console.error("    - upload 'xml2json.xls' file to /etc/openhab/transform");
            return null;
	}

       // API returns an Acknowledgement_MarketDocument when prices are not available
       if ('Acknowledgement_MarketDocument' in json_response) {
	    try {
		var error_reason = json_response['Acknowledgement_MarketDocument']['Reason']['text']['#'];
		console.warn("[entsoe.js]-> Error reason: %s", error_reason);
	    } catch (exception) {
		console.error("[entsoe.js]-> Unexpected Acknowledgement_MarketDocument response!");
            	console.error(json_response)
	    }
            return null;

       // API returns Publication_MarketDocument when prices are available
       } else if ('Publication_MarketDocument' in json_response) {
           try {
               if (Array.isArray(json_response['Publication_MarketDocument']['TimeSeries'])) {
                   console.info("Timeseries for few days")
                   var n = json_response['Publication_MarketDocument']['TimeSeries'].length;

		   for (var index=0; index < n; index++) {
                       var raw_time_series = json_response['Publication_MarketDocument']['TimeSeries'][index];
		       price_for_every_hour = price_for_every_hour.concat(this.parse_entsoe_raw_timeseries(raw_time_series));
                   }

               } else {
                   console.info("Timeseries for single day")
                   var raw_time_series = json_response['Publication_MarketDocument']['TimeSeries'];
		   price_for_every_hour = price_for_every_hour.concat(this.parse_entsoe_raw_timeseries(raw_time_series));
               }

           } catch(exception) {
               console.error("[entsoe.js] -> Unexpected 'Publication_MarketDocument' response!");
	       console.error(raw_xml_response);
               return null;
           }

       } else {
           console.error('[entsoe.js] -> Unexpected response type!');
           console.error(raw_xml_response);
           return null;
       } // close last 'else'

       var electricity_time_period = {}
       for (var index=0; index < price_for_every_hour.length; index++) {
		electricity_time_period = { ...electricity_time_period, ...price_for_every_hour[index]};
       }

       return electricity_time_period;
   }   // end func [parse_entsoe_response]


   parse_entsoe_raw_timeseries(raw_ts){
	var price_watt = null;
	var price_by_hour = {};

/*        if (raw_ts['currency_Unit.name']['#'] != "EUR") {
                 console.warn("Current version doesn't support received currency: ", raw_ts['currency_Unit.name']['#']);
                 return null;
        }

	if (raw_ts['price_Measure_Unit.name']['#'] != "MWH") {
		console.warn("Current version doesn't support received measure unit: ", raw_ts['price_Measure_Unit.name']['#']);
		return null;
	}

	if (raw_ts['Period']['resolution']['#'] != "PT60M") {
		console.warn("Current version doesn't support following period interval: ", raw_ts['Period']['resolution']['#']);
		return null;
	}
*/
	/*
	* Usually in raw_ts Period -> timeInterval -> start = "2024-04-15T22:00Z",
	* 		    Period -> timeInterval -> end   = "2024-04-16T22:00Z"
	*
	*    For example, consider the day of February 2 2016 in CET (winter time)
	*        request: start at 2016-01-01 at 23:00 and end at 2016-01-02 at 23:00.
	*
	*    For example,  July 5 2016 in CET (summer time)
	*        request:  start at 2016-07-04 at 22:00 and end at 2016-07-05 at 22:00.
	*
	* So, make assumption that necessary day will be "Period->time Interval->end"
	*/

	var entsoe_day = raw_ts['Period']['timeInterval']['end']['#'].split('T')[0];

	var entsoe_points = raw_ts['Period']['Point'];

	for (var index=0; index < entsoe_points.length; index++){

		var entsoe_day_hour = new Date(entsoe_day);
		entsoe_day_hour.setHours(parseInt(entsoe_points[index]['position']['#'], 0, 0, 0));

		if ( entsoe_day_hour.getTime() >= this.user_time_begin.getTime() &&
		     entsoe_day_hour.getTime() <= this.user_time_end.getTime() ) {

		    var property_date = this.formatTimestamp(entsoe_day_hour);

                    if (!this.property[property_date.split(" ")[0]]) {
                          this.property[property_date.split(" ")[0]] = {"currency":   raw_ts['currency_Unit.name']['#'],
                                      		       			"unit":       raw_ts['price_Measure_Unit.name']['#'],
                                                       			"resolution": raw_ts['Period']['resolution']['#']};
                    }

		    if (this.cnt_kWh) {
			price_watt = ((entsoe_points[index]['price.amount']['#']/10)*(1 + this.tax/100)).toFixed(this.rounding_precision);
		    } else {
			price_watt = ((entsoe_points[index]['price.amount']['#'])*(1 + this.tax/100)).toFixed(this.rounding_precision);
		    }
		    price_by_hour[this.formatTimestamp(entsoe_day_hour)] = parseFloat(price_watt);
		} // close if entsoe_day_hour
	} // close for (var index=0; index < entsoe_points.lengt; index++)

	return price_by_hour;
   }    // end func [parse_entsoe_raw_timeseries(raw_ts)]


    formatTimestamp(date) {
	var year  = date.getFullYear();
 	var month = (date.getMonth() + 1).toString().padStart(2, '0'); // Month is zero-indexed
 	var day = date.getDate().toString().padStart(2, '0');
 	var hours = date.getHours().toString().padStart(2, '0');
 	var minutes = date.getMinutes().toString().padStart(2, '0');

	return `${year}-${month}-${day} ${hours}:${minutes}`;
    }

/*
 * Input @user_period:
 *	{ "yyyy-mm-dd HH:mm" : price,
 *	  "yyyy-mm-dd HH:mm" : price,
 *	  .....
 *	  "yyyy-mm-dd HH:mm" : price}
 *
 * Return
 *	{
 *	 "yyyy-mm-dd": [
 *    		{
 *		  "time": "00:00",
 *     		  "price": 0.5
 *    		},
 *   		{
 *     		  "time": "01:00",
 *     		  "price": 0.32
 *   		},
 *		...
 *		]
 *	}
*/
    group_by_days(user_period) {
	var entose_days = {};

	for (var [timestamp, price] of Object.entries(user_period)) {
		var [date, time] = timestamp.split(' ');

		if (!entose_days[date]) {
            		 entose_days[date] = [];
		}

         entose_days[date].push({ time, price });
	}

	return entose_days;
    }   // end func [group_by_days]


}       // close 'Entsoe' class

module.exports = {
    Entsoe
}
